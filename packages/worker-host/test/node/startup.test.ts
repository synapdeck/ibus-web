// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { HostInit } from "../../src/shared/messages.ts";
import { describe, expect, test } from "vitest";
import { checkManifest, readManifest, readRuntimeConstants } from "../../src/worker/startup.ts";

const root = "/nix/store/00000000000000000000000000000000-schemas";
const constants = {
  runtimeAbi: 1,
  protocol: 1,
  memory: { minimum: 65536, maximum: 131072 },
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
  protocol: 1,
  memory: 65536,
  threads: 0,
  module: { url: "https://example.test/test.wasm", size: 1 },
  data: [{ storePath: root, url: "https://example.test/schemas.tar", size: 0, encoding: "identity" }],
  settingsSchemaDir: `${root}/schemas`,
  engines: [{ name: "test", displayName: "test", languages: [], keyboard: { layout: "us", passThrough: [] } }],
  settingsSchemas: [],
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
  test("identifies both identity mismatches", () => {
    expect(() => checkManifest({ ...manifest, runtimeAbi: 2 }, constants)).toThrow(/RuntimeAbiMismatch.*2.*1/);
    expect(() => checkManifest({ ...manifest, protocol: 2 }, constants)).toThrow(/ProtocolMismatch.*2.*1/);
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
      const result = await readManifest({ manifestUrl: `${origin}${path}` } as HostInit<unknown, unknown>, constants);
      expect(result.module.url).toBe(`${origin}/v1/engine.wasm`);
      expect(result.data[0]!.url).toBe(`${origin}/v1/schemas.tar`);
    }
    const inline = await readManifest({ manifest: relative } as HostInit<unknown, unknown>, constants);
    expect(inline.module.url).toBe("./engine.wasm");
    expect(inline.data[0]!.url).toBe("./schemas.tar");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
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
      for (const value of [{}, { ...shipped, poolLowWater: -1 }, { ...shipped, canceled: "errno" }]) {
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
