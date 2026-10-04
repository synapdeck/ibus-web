// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, it } from "vitest";
import { decodeEngineManifest } from "../src/manifest.ts";

const bounds = { minimum: 32 * 1024 * 1024, maximum: 2 ** 31 };
const storePath = "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-hangul-data";
const valid = {
  name: "hangul",
  version: "1",
  license: "GPL-2.0-or-later",
  runtimeAbi: 1,
  protocol: 1,
  module: { url: "./hangul.wasm", size: 1024 },
  memory: bounds.minimum,
  threads: 0,
  data: [{ storePath, url: "./data/hangul.tar.br", size: 4096, encoding: "br" }],
  settingsSchemaDir: `${storePath}/share/glib-2.0/schemas`,
  engines: ["hangul"],
  settingsSchemas: ["org.freedesktop.ibus.engine.hangul"],
};

describe("engine manifests", () => {
  it("decodes a valid manifest", () => expect(decodeEngineManifest(valid, bounds)).toEqual(valid));
  it("accepts identity archives", () =>
    expect(
      decodeEngineManifest({ ...valid, data: [{ ...valid.data[0], encoding: "identity" }] }, bounds),
    ).toBeDefined());
  it("requires the version", () => {
    const { version: _, ...missing } = valid;
    expect(() => decodeEngineManifest(missing, bounds)).toThrow();
  });
  it.each([undefined, "gzip"])("rejects encoding %s", (encoding) => {
    expect(() => decodeEngineManifest({ ...valid, data: [{ ...valid.data[0], encoding }] }, bounds)).toThrow();
  });
  it.each([bounds.minimum - 65536, bounds.maximum + 65536, bounds.minimum + 1])("rejects memory %s", (memory) => {
    expect(() => decodeEngineManifest({ ...valid, memory }, bounds)).toThrow();
  });
  it("uses the supplied runtime minimum", () =>
    expect(() => decodeEngineManifest(valid, { ...bounds, minimum: bounds.minimum * 2 })).toThrow());
  it.each([-1, 0.5])("rejects threads %s", (threads) =>
    expect(() => decodeEngineManifest({ ...valid, threads }, bounds)).toThrow(),
  );
  it.each(["/usr/share/hangul", `${storePath}/nested`, "/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-data"])(
    "rejects store path %s",
    (path) => {
      expect(() => decodeEngineManifest({ ...valid, data: [{ ...valid.data[0], storePath: path }] }, bounds)).toThrow();
    },
  );
  it("rejects duplicate store paths", () =>
    expect(() => decodeEngineManifest({ ...valid, data: [...valid.data, ...valid.data] }, bounds)).toThrow());
  it.each(["/usr/share/schemas", `${storePath}-other/schemas`, `${storePath}/../schemas`])(
    "rejects schema directory %s",
    (settingsSchemaDir) => {
      expect(() => decodeEngineManifest({ ...valid, settingsSchemaDir }, bounds)).toThrow();
    },
  );
});
