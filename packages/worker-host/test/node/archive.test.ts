// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test, vi } from "vitest";
import { installArchives } from "../../src/worker/install/archive.ts";
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
  engines: ["test"],
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
