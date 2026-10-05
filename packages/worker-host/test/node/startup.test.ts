// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { HostInit } from "../../src/shared/messages.ts";
import { describe, expect, test } from "vitest";
import { checkManifest, readManifest } from "../../src/worker/startup.ts";

const root = "/nix/store/00000000000000000000000000000000-schemas";
const constants = {
  runtimeAbi: 1,
  protocol: 1,
  memory: { minimum: 65536, maximum: 131072 },
  pumpError: -1,
  waitTimedOut: -2,
  idbReadOnly: 1,
  canceled: -11,
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
  engines: ["test"],
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
      const result = await readManifest({ constants, manifestUrl: `${origin}${path}` } as HostInit<unknown, unknown>);
      expect(result.module.url).toBe(`${origin}/v1/engine.wasm`);
      expect(result.data[0]!.url).toBe(`${origin}/v1/schemas.tar`);
    }
    const inline = await readManifest({ constants, manifest: relative } as HostInit<unknown, unknown>);
    expect(inline.module.url).toBe("./engine.wasm");
    expect(inline.data[0]!.url).toBe("./schemas.tar");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
