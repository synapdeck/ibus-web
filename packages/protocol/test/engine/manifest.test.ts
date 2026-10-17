// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, test } from "vitest";
import { decodeModuleManifest, lazyStorePaths } from "../../src/manifest.ts";

const bounds = { minimum: 32 * 1024 * 1024, maximum: 2 ** 31 };
const storePath = "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-hangul-data";
const engine = {
  name: "hangul",
  displayName: "Hangul",
  languages: ["ko"],
  keyboard: { layout: "us", passThrough: [] },
};
const valid = {
  name: "hangul",
  version: "1",
  license: "GPL-2.0-or-later",
  runtimeAbi: 1,
  runtimeIdentity: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  protocol: 1,
  module: { url: "./hangul.wasm", size: 1024 },
  memory: bounds.minimum,
  threads: 0,
  data: [{ storePath, url: "./data/hangul.tar.br", size: 4096, files: 1, encoding: "br" }],
  settingsSchemaDir: `${storePath}/share/glib-2.0/schemas`,
  engines: [engine],
  settingsSchemas: ["org.freedesktop.ibus.engine.hangul"],
};

describe("module manifests", () => {
  test("decodes a valid manifest", () => expect(decodeModuleManifest(valid, bounds)).toEqual(valid));
  test("requires the runtime's identity as SHA-256 in lowercase hexadecimal", () => {
    const { runtimeIdentity: _, ...missing } = valid;
    expect(() => decodeModuleManifest(missing, bounds)).toThrow();
    for (const runtimeIdentity of ["0".repeat(63), "0".repeat(65), "A".repeat(64), "g".repeat(64)])
      expect(() => decodeModuleManifest({ ...valid, runtimeIdentity }, bounds)).toThrow();
  });
  test("accepts identity archives", () =>
    expect(
      decodeModuleManifest({ ...valid, data: [{ ...valid.data[0], encoding: "identity" }] }, bounds),
    ).toBeDefined());
  test("requires each engine's keyboard", () => {
    const { keyboard: _, ...missing } = engine;
    expect(() => decodeModuleManifest({ ...valid, engines: [missing] }, bounds)).toThrow();
  });
  test("rejects unknown layout", () =>
    expect(() =>
      decodeModuleManifest({ ...valid, engines: [{ ...engine, keyboard: { layout: "de", passThrough: [] } }] }, bounds),
    ).toThrow());
  test("rejects a keyboard outside the engines", () =>
    expect(() => decodeModuleManifest({ ...valid, keyboard: engine.keyboard }, bounds)).toThrow());
  test("requires the version", () => {
    const { version: _, ...missing } = valid;
    expect(() => decodeModuleManifest(missing, bounds)).toThrow();
  });
  test("requires each archive's entry count", () => {
    const { files: _, ...missing } = valid.data[0]!;
    expect(() => decodeModuleManifest({ ...valid, data: [missing] }, bounds)).toThrow();
    for (const files of [-1, 1.5])
      expect(() => decodeModuleManifest({ ...valid, data: [{ ...valid.data[0], files }] }, bounds)).toThrow();
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
  test.each(["name", "displayName"])("rejects an empty engine %s", (field) =>
    expect(() => decodeModuleManifest({ ...valid, engines: [{ ...engine, [field]: "" }] }, bounds)).toThrow(),
  );
  test("rejects duplicate engine names", () =>
    expect(() =>
      decodeModuleManifest({ ...valid, engines: [engine, { ...engine, displayName: "Other" }] }, bounds),
    ).toThrow());
  test("keeps several engines in order, the first being the default", () =>
    expect(
      decodeModuleManifest({ ...valid, engines: [engine, { ...engine, name: "romaja" }] }, bounds).engines.map(
        (descriptor) => descriptor.name,
      ),
    ).toEqual(["hangul", "romaja"]));
  test.each([
    ["the manifest", { ...valid, extra: 1 }],
    ["the module", { ...valid, module: { ...valid.module, extra: 1 } }],
    ["a data entry", { ...valid, data: [{ ...valid.data[0], extra: 1 }] }],
    ["an engine", { ...valid, engines: [{ ...engine, extra: 1 }] }],
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

describe("an engine's own data", () => {
  const dictionary = "/nix/store/1123456789abcdfghijklmnpqrsvwxyz-dictionary";
  const withDictionary = {
    ...valid,
    data: [
      ...valid.data,
      { storePath: dictionary, url: "./data/dictionary.tar.br", size: 8192, files: 1, encoding: "br" },
    ],
    engines: [
      { ...engine, data: [dictionary] },
      { ...engine, name: "romaja" },
    ],
  };

  test("decodes an engine's data, and an engine without it", () =>
    expect(decodeModuleManifest(withDictionary, bounds)).toEqual(withDictionary));
  test("lists the store paths engines name as lazy, and nothing else", () => {
    expect([...lazyStorePaths(decodeModuleManifest(withDictionary, bounds))]).toEqual([dictionary]);
    expect([...lazyStorePaths(decodeModuleManifest(valid, bounds))]).toEqual([]);
  });
  test("takes a path several engines name once", () =>
    expect([
      ...lazyStorePaths(
        decodeModuleManifest(
          {
            ...withDictionary,
            engines: [
              { ...engine, data: [dictionary] },
              { ...engine, name: "romaja", data: [dictionary] },
            ],
          },
          bounds,
        ),
      ),
    ]).toEqual([dictionary]));
  test("rejects a path not in the module's data", () =>
    expect(() =>
      decodeModuleManifest({ ...withDictionary, engines: [{ ...engine, data: [`${dictionary}-other`] }] }, bounds),
    ).toThrow(/engine hangul's data \/nix\/store\/\S+-dictionary-other is not in the module's data/));
  test("rejects a path named twice by one engine", () =>
    expect(() =>
      decodeModuleManifest({ ...withDictionary, engines: [{ ...engine, data: [dictionary, dictionary] }] }, bounds),
    ).toThrow(/engine hangul names a data store path twice/));
  test("rejects a path that isn't a store path", () =>
    expect(() =>
      decodeModuleManifest({ ...withDictionary, engines: [{ ...engine, data: ["/usr/share/dictionary"] }] }, bounds),
    ).toThrow());
  test("rejects lazy data holding the schema directory", () =>
    expect(() =>
      decodeModuleManifest({ ...withDictionary, engines: [{ ...engine, data: [storePath] }] }, bounds),
    ).toThrow(/schema directory is in \/nix\/store\/\S+-hangul-data, which installs only with an engine/));
});
