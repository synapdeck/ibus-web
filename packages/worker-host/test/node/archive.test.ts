// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, test, vi } from "vitest";
import { installArchives } from "../../src/worker/install/archive.ts";
import { entryGuard } from "../../src/worker/install/entries.ts";
import { RuntimeRefused, type Runtime, type RuntimeHandle } from "../../src/worker/runtime.ts";
import type { EngineManifest } from "../../src/shared/messages.ts";

const engine: EngineManifest = {
  version: "1",
  license: "MIT",
  runtimeAbi: 1,
  protocol: 1,
  memory: 65536,
  threads: 0,
  module: { url: "https://unused.test/engine.wasm", size: 1 },
  settingsSchemaDir: "/nix/store/00000000000000000000000000000000-data/schemas",
  engines: ["allocation"],
  settingsSchemas: [],
  name: "allocation",
  data: [
    {
      url: "https://unused.test/data.tar",
      storePath: "/nix/store/00000000000000000000000000000000-data",
      size: 0,
      encoding: "identity",
    },
  ],
};

test.each(["trap", "refusal"])("second scratch allocation %s cleans up only an intact runtime", async (failure) => {
  const calls: string[] = [];
  const trap = new WebAssembly.RuntimeError("unreachable");
  const rt = {
    _malloc: () => {
      calls.push("malloc");
      if (calls.length === 1) return 16;
      if (failure === "trap") throw trap;
      return 0;
    },
    _free: () => {
      calls.push("free");
    },
  } as unknown as Runtime;
  vi.useFakeTimers();
  try {
    const promise = installArchives({ rt } as RuntimeHandle, engine, {
      idleMs: 1000,
      forceBrotliFallback: false,
      brotliDecoder: () => {},
      beforePiece: () => undefined,
    });
    if (failure === "trap") await expect(promise).rejects.toBe(trap);
    else await expect(promise).rejects.toBeInstanceOf(RuntimeRefused);
    expect(calls).toEqual(failure === "trap" ? ["malloc", "malloc"] : ["malloc", "malloc", "free"]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

// A ustar member's header, checksummed, then its data padded to a block.
const member = (name: string, { prefix = "", type = "0", data = "" } = {}): Uint8Array => {
  const encoder = new TextEncoder();
  const body = encoder.encode(data);
  const block = new Uint8Array(512 + Math.ceil(body.length / 512) * 512);
  const put = (offset: number, text: string) => block.set(encoder.encode(text), offset);
  put(0, name);
  put(100, "0000644\0");
  put(124, `${body.length.toString(8).padStart(11, "0")}\0`);
  put(156, type);
  put(257, "ustar\0");
  put(263, "00");
  put(345, prefix);
  put(148, "        ");
  put(
    148,
    `${block
      .subarray(0, 512)
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, "0")}\0 `,
  );
  block.set(body, 512);
  return block;
};

const tar = (...members: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(members.reduce((sum, m) => sum + m.length, 0) + 1024);
  let at = 0;
  for (const m of members) {
    out.set(m, at);
    at += m.length;
  }
  return out;
};

const BASE = "00000000000000000000000000000000-data";

// Hands the archive to the guard in pieces of the size, as the installer
// does before feeding each.
const guarded = (archive: Uint8Array, piece: number): void => {
  const guard = entryGuard(BASE);
  for (let at = 0; at < archive.length; at += piece) guard(archive.subarray(at, at + piece));
};

describe("archive entries", () => {
  const pieces = [1, 7, 511, 512, 513, 65536];

  test.each(pieces)("lie under the store path, in pieces of %i bytes", (piece) => {
    // A data block that looks like a header naming another store path is
    // data, not a member.
    const lookalike = new TextDecoder().decode(member("11111111111111111111111111111111-other/x"));
    const archive = tar(
      member(`${BASE}/`, { type: "5" }),
      member(`./${BASE}/share/data.txt`, { data: "data\n" }),
      member(`${BASE}/share/lookalike`, { data: lookalike }),
      member(`${"f".repeat(90)}.txt`, { prefix: `${BASE}/long` }),
      member(`${BASE}/share/link`, { type: "2" }),
    );
    expect(() => guarded(archive, piece)).not.toThrow();
  });

  test("may be the store path alone, a single file", () => {
    expect(() => guarded(tar(member(BASE, { data: "single\n" })), 512)).not.toThrow();
  });

  test("past the end of the archive are not looked at", () => {
    const archive = new Uint8Array([...tar(member(`${BASE}/a`)), ...member("elsewhere")]);
    expect(() => guarded(archive, 512)).not.toThrow();
  });

  test.each([
    ["another store path", "11111111111111111111111111111111-other/x"],
    ["a name the store path's begins", `${BASE}x/y`],
    ["a bare name", "x"],
    ["the store itself", "./"],
    ["an absolute name", `/nix/store/${BASE}/x`],
  ])("outside it, as %s, fail before the header is fed", (_, name) => {
    const archive = tar(member(`${BASE}/ok`, { data: "ok" }), member(name));
    for (const piece of pieces) expect(() => guarded(archive, piece)).toThrow(`lies outside ${BASE}`);
  });

  test("outside it through the prefix field fail", () => {
    expect(() => guarded(tar(member("x", { prefix: "elsewhere" })), 512)).toThrow(`lies outside ${BASE}`);
  });
});
