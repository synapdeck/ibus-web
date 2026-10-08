// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, test } from "vitest";
import { decodeModuleManifest } from "../../src/manifest.ts";

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
  keyboard: { layout: "us", passThrough: [] },
  settingsSchemas: ["org.freedesktop.ibus.engine.hangul"],
};

describe("engine manifests", () => {
  test("decodes a valid manifest", () => expect(decodeModuleManifest(valid, bounds)).toEqual(valid));
  test("accepts identity archives", () =>
    expect(
      decodeModuleManifest({ ...valid, data: [{ ...valid.data[0], encoding: "identity" }] }, bounds),
    ).toBeDefined());
  test("requires keyboard", () => {
    const { keyboard: _, ...missing } = valid;
    expect(() => decodeModuleManifest(missing, bounds)).toThrow();
  });
  test("rejects unknown layout", () =>
    expect(() => decodeModuleManifest({ ...valid, keyboard: { layout: "de", passThrough: [] } }, bounds)).toThrow());
  test("requires the version", () => {
    const { version: _, ...missing } = valid;
    expect(() => decodeModuleManifest(missing, bounds)).toThrow();
  });
  test.each([undefined, "gzip"])("rejects encoding %s", (encoding) => {
    expect(() => decodeModuleManifest({ ...valid, data: [{ ...valid.data[0], encoding }] }, bounds)).toThrow();
  });
  test.each([bounds.minimum - 65536, bounds.maximum + 65536, bounds.minimum + 1])("rejects memory %s", (memory) => {
    expect(() => decodeModuleManifest({ ...valid, memory }, bounds)).toThrow();
  });
  test("uses the supplied runtime minimum", () =>
    expect(() => decodeModuleManifest(valid, { ...bounds, minimum: bounds.minimum * 2 })).toThrow());
  test.each([-1, 0.5])("rejects threads %s", (threads) =>
    expect(() => decodeModuleManifest({ ...valid, threads }, bounds)).toThrow(),
  );
  test.each(["/usr/share/hangul", `${storePath}/nested`, "/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-data"])(
    "rejects store path %s",
    (path) => {
      expect(() => decodeModuleManifest({ ...valid, data: [{ ...valid.data[0], storePath: path }] }, bounds)).toThrow();
    },
  );
  test("rejects duplicate store paths", () =>
    expect(() => decodeModuleManifest({ ...valid, data: [...valid.data, ...valid.data] }, bounds)).toThrow());
  test.each(["/usr/share/schemas", `${storePath}-other/schemas`, `${storePath}/../schemas`])(
    "rejects schema directory %s",
    (settingsSchemaDir) => {
      expect(() => decodeModuleManifest({ ...valid, settingsSchemaDir }, bounds)).toThrow();
    },
  );
  test.each(["", ".", "..", "a/b", "/hangul", ".hidden", "-hangul", "han gul", "hangul\0", "한글"])(
    "rejects name %j",
    (name) => expect(() => decodeModuleManifest({ ...valid, name }, bounds)).toThrow(),
  );
  test.each(["hangul", "Hangul2", "m17n.ko", "chewing-plus", "x_y+z", "a..b"])("accepts name %j", (name) =>
    expect(decodeModuleManifest({ ...valid, name }, bounds).name).toBe(name),
  );
  test("rejects an empty license", () =>
    expect(() => decodeModuleManifest({ ...valid, license: "" }, bounds)).toThrow());
  test("rejects an empty module url", () =>
    expect(() => decodeModuleManifest({ ...valid, module: { ...valid.module, url: "" } }, bounds)).toThrow());
  test("rejects an empty data url", () =>
    expect(() => decodeModuleManifest({ ...valid, data: [{ ...valid.data[0], url: "" }] }, bounds)).toThrow());
  test("requires at least one engine", () =>
    expect(() => decodeModuleManifest({ ...valid, engines: [] }, bounds)).toThrow());
  test("rejects an empty engine name", () =>
    expect(() => decodeModuleManifest({ ...valid, engines: [""] }, bounds)).toThrow());
  test.each([
    ["the manifest", { ...valid, extra: 1 }],
    ["the module", { ...valid, module: { ...valid.module, extra: 1 } }],
    ["a data entry", { ...valid, data: [{ ...valid.data[0], extra: 1 }] }],
  ])("rejects an excess key in %s", (_, manifest) => expect(() => decodeModuleManifest(manifest, bounds)).toThrow());
  test.each([`${storePath}//schemas`, `${storePath}/share/`, `${storePath}/`, `${storePath}/share//`])(
    "rejects schema directory %s with an empty component",
    (settingsSchemaDir) => expect(() => decodeModuleManifest({ ...valid, settingsSchemaDir }, bounds)).toThrow(),
  );
});

test("accepts an optional settings metadata asset and validates its size and URL", () => {
  const settingsMetadata = { url: "./settings.json", size: 200 };
  expect(decodeModuleManifest({ ...valid, settingsMetadata }, bounds).settingsMetadata).toEqual(settingsMetadata);
  for (const asset of [
    { url: "", size: 200 },
    { url: "./settings.json", size: -1 },
  ])
    expect(() => decodeModuleManifest({ ...valid, settingsMetadata: asset }, bounds)).toThrow();
});
