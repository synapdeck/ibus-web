// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { WasmModuleManifest } from "@ibus-web/protocol";
import type { HostInit } from "../../src/shared/messages.ts";
import { describe, expect, test } from "vitest";
import {
  checkJsManifest,
  checkManifest,
  readManifest,
  readRuntimeConstants,
  type StartingModule,
} from "../../src/worker/startup.ts";

const root = "/nix/store/00000000000000000000000000000000-schemas";
const constants = {
  runtimeAbi: 1,
  runtimeIdentity: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  protocol: 1,
  memory: { minimum: 65536, maximum: 131072 },
  memoryFileBytes: 512,
  pumpError: -1,
  waitTimedOut: -2,
  idbReadOnly: 1,
  canceled: -11,
  fs: {
    errno: { EEXIST: 20, EFBIG: 22, EINVAL: 28, EISDIR: 31, ENOENT: 44, ENOTDIR: 54, EOPNOTSUPP: 138 },
    open: { O_WRONLY: 1, O_CREAT: 64, O_TRUNC: 512, O_NOFOLLOW: 131072 },
    mode: { S_IFMT: 61440, S_IFDIR: 16384, S_IFLNK: 40960, S_IFREG: 32768 },
  },
};
const manifest = {
  name: "test",
  version: "1",
  license: "MIT",
  runtimeAbi: 1,
  runtimeIdentity: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  protocol: 1,
  memory: 65536,
  threads: 0,
  module: { url: "https://example.test/test.wasm", size: 1 },
  data: [{ storePath: root, url: "https://example.test/schemas.tar", size: 0, files: 1, encoding: "identity" }],
  settingsSchemaDir: `${root}/schemas`,
  engines: [{ name: "test", displayName: "test", languages: [], keyboard: { layout: "us", passThrough: [] } }],
  settingsSchemas: [],
};
const js = {
  kind: "js",
  name: "test",
  version: "1",
  license: "MIT",
  protocol: 1,
  moduleAbi: 1,
  module: { url: "./test.js", size: 1 },
  engines: manifest.engines,
  settingsSchemas: [],
};
const runtime = async () => ({ ...constants, poolLowWater: 0 });
const wasm = (starting: StartingModule): WasmModuleManifest => {
  if (starting.kind === "js") throw new Error("expected a WebAssembly manifest");
  return starting.manifest;
};
describe("manifest startup validation", () => {
  test("accepts the runtime's lower and upper memory bounds", () => {
    for (const memory of [65536, 131072]) expect(checkManifest({ ...manifest, memory }, constants).memory).toBe(memory);
  });
  test("identifies invalid memory and its runtime bounds", () => {
    for (const memory of [65535, 65537, 196608]) {
      expect(() => checkManifest({ ...manifest, memory }, constants)).toThrow(/manifest/);
      expect(() => checkManifest({ ...manifest, memory }, constants)).toThrow(/65536.*131072/);
    }
  });
  test("refuses a mismatched or invalid manifest for good", () => {
    for (const [change, refused] of [
      [{ runtimeAbi: 2 }, "RuntimeAbiMismatch"],
      [{ runtimeIdentity: "f".repeat(64) }, "RuntimeAbiMismatch"],
      [{ protocol: 2 }, "ProtocolMismatch"],
      [{ memory: 65537 }, "manifest"],
    ] as const)
      expect(() => checkManifest({ ...manifest, ...change }, constants)).toThrow(expect.objectContaining({ refused }));
  });
  test("identifies both identity mismatches", () => {
    expect(() => checkManifest({ ...manifest, runtimeAbi: 2 }, constants)).toThrow(/RuntimeAbiMismatch.*2.*1/);
    expect(() => checkManifest({ ...manifest, runtimeIdentity: "f".repeat(64) }, constants)).toThrow(
      new RegExp(`RuntimeAbiMismatch: manifest identity f{64}, runtime ${constants.runtimeIdentity}`),
    );
    expect(() => checkManifest({ ...manifest, protocol: 2 }, constants)).toThrow(/ProtocolMismatch.*2.*1/);
  });
  test("checks a JavaScript manifest against the host's protocol and module ABI, refusing a mismatch for good", () => {
    expect(checkJsManifest(js)).toEqual(js);
    for (const [change, refused, message] of [
      [{ protocol: 2 }, "ProtocolMismatch", /ProtocolMismatch: manifest 2, host 1/],
      [{ moduleAbi: 2 }, "ModuleAbiMismatch", /ModuleAbiMismatch: manifest 2, host 1/],
      [{ runtimeAbi: 1 }, "manifest", /runtimeAbi/],
    ] as const) {
      expect(() => checkJsManifest({ ...js, ...change })).toThrow(expect.objectContaining({ refused }));
      expect(() => checkJsManifest({ ...js, ...change })).toThrow(message);
    }
    expect(() => checkManifest(js, constants)).toThrow(expect.objectContaining({ refused: "manifest" }));
  });
  test("rejects missing threads", () => {
    const { threads: _, ...missing } = manifest;
    expect(() => checkManifest(missing, constants)).toThrow(/threads/);
  });
});

test("redirected manifests resolve relative assets from their final location", async () => {
  const relative = {
    ...manifest,
    module: { url: "./engine.wasm", size: 1 },
    data: [{ ...manifest.data[0]!, url: "./schemas.tar" }],
  };
  const server = createServer((request, response) => {
    if (request.url === "/latest.json") {
      response.writeHead(302, { Location: "/v1/manifest.json" });
      response.end();
    } else if (request.url === "/v1/manifest.json") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(relative));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const path of ["/latest.json", "/v1/manifest.json"]) {
      const result = wasm(
        await readManifest({ manifestUrl: `${origin}${path}` } as HostInit<unknown, unknown>, runtime),
      );
      expect(result.module.url).toBe(`${origin}/v1/engine.wasm`);
      expect(result.data[0]!.url).toBe(`${origin}/v1/schemas.tar`);
    }
    const inline = wasm(await readManifest({ manifest: relative } as HostInit<unknown, unknown>, runtime));
    expect(inline.module.url).toBe("./engine.wasm");
    expect(inline.data[0]!.url).toBe("./schemas.tar");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a JavaScript manifest's script resolves from the manifest's final location, without the runtime", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/v1/manifest.json") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(js));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const result = await readManifest({ manifestUrl: `${origin}/v1/manifest.json` } as HostInit<unknown, unknown>, () =>
      Promise.reject(new Error("the runtime's constants were read")),
    );
    expect(result).toEqual({ kind: "js", manifest: { ...js, module: { url: `${origin}/v1/test.js`, size: 1 } } });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a manifest that can't be read is reported before the constants are, and one that can is checked after them", async () => {
  const constants = () => Promise.reject(new Error("constants.json is broken"));
  await expect(readManifest({} as HostInit<unknown, unknown>, constants)).rejects.toThrow(
    "manifest or manifestUrl is required",
  );
  await expect(readManifest({ manifest: { name: "broken" } } as HostInit<unknown, unknown>, constants)).rejects.toThrow(
    "constants.json is broken",
  );
});

describe("runtime constants startup", () => {
  test("loads every runtime constant beside the runtime URL", async () => {
    const directory = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { pathToFileURL } = await import("node:url");
    const path = await directory.mkdtemp(`${tmpdir()}/runtime-constants-`);
    const runtimeUrl = pathToFileURL(`${path}/ibus-runtime.js`).href;
    const shipped = { ...constants, poolLowWater: 3 };
    try {
      await expect(readRuntimeConstants(runtimeUrl)).rejects.toThrow(/constants\.json/);
      await directory.writeFile(`${path}/constants.json`, "{");
      await expect(readRuntimeConstants(runtimeUrl)).rejects.toThrow(/constants\.json/);
      const { memoryFileBytes: _, ...withoutFileBytes } = shipped;
      for (const value of [
        {},
        { ...shipped, poolLowWater: -1 },
        { ...shipped, canceled: "errno" },
        withoutFileBytes,
        { ...shipped, memoryFileBytes: -1 },
      ]) {
        await directory.writeFile(`${path}/constants.json`, JSON.stringify(value));
        await expect(readRuntimeConstants(runtimeUrl)).rejects.toThrow(/constants\.json/);
      }
      await directory.writeFile(`${path}/constants.json`, JSON.stringify(shipped));
      expect(await readRuntimeConstants(runtimeUrl)).toEqual(shipped);
    } finally {
      await directory.rm(path, { recursive: true });
    }
  });
});
