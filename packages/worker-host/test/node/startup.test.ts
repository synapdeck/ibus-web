// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, test } from "vitest";
import { checkManifest } from "../../src/worker/startup.ts";

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
  engines: [],
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
