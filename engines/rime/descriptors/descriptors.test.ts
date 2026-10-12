// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, test } from "vitest";
import {
  closure,
  deployed,
  engineData,
  engineDescriptor,
  generate,
  header,
  instances,
  type Plan,
  type RawSchema,
  settingSwitchesOf,
  type TableEntry,
} from "./descriptors.ts";

const raw = (id: string, overrides: Partial<RawSchema> = {}): RawSchema => ({
  id,
  name: id.toUpperCase(),
  dictionary: id,
  dependencies: [],
  switches: [],
  algebra: [],
  ...overrides,
});

const entry = (overrides: Partial<TableEntry> = {}): TableEntry => ({
  gloss: "Gloss",
  languages: ["zh-Hans"],
  from: "rime-data",
  dictionary: "",
  dependencies: [],
  ...overrides,
});

const toggle = (name: string) => ({ name, options: [], states: ["off", "on"] });

const ice = raw("rime_ice", {
  name: "雾凇拼音",
  dependencies: ["melt_eng", "radical_pinyin"],
  switches: [toggle("ascii_mode"), toggle("ascii_punct"), toggle("traditionalization"), toggle("full_shape")],
  algebra: ["erase/^hm$/", 'xform/"/\\\\/'],
});
const melt = raw("melt_eng");
const radical = raw("radical_pinyin");
const luna = raw("luna_pinyin", {
  name: "朙月拼音",
  dependencies: ["stroke"],
  switches: [toggle("ascii_mode"), toggle("full_shape"), toggle("simplification")],
});
const stroke = raw("stroke", { dependencies: ["luna_pinyin"] });
const jyut = raw("jyut6ping3", {
  dependencies: ["luna_pinyin", "stroke"],
  switches: [
    toggle("ascii_mode"),
    { name: "", options: ["noop", "variants_hk", "simplification"], states: ["a", "b", "c"] },
  ],
});
const array = raw("array30", { dependencies: [] });
const query = raw("array30_query");

const all = [ice, melt, radical, luna, stroke, jyut, array, query];

const plan = (schemas: string[], overrides: Partial<Plan> = {}): Plan => ({
  schemas,
  table: Object.fromEntries(
    all.map((schema) => [
      schema.id,
      entry({
        dictionary: schema.dictionary,
        dependencies: schema.dependencies,
        from:
          schema.id === "rime_ice" || schema.id === "melt_eng" || schema.id === "radical_pinyin"
            ? "rime-ice"
            : "rime-data",
        ...(schema.id === "array30" ? { undeclared: ["array30_query"] } : {}),
      }),
    ]),
  ),
  dictionaries: Object.fromEntries(all.map((schema) => [schema.dictionary, `/nix/store/${schema.dictionary}`])),
  ...overrides,
});

describe("the table", () => {
  test("must agree with the deployed configs", () => {
    expect(deployed(all, plan([])).size).toBe(all.length);
    const wrong = plan([]);
    wrong.table["luna_pinyin"] = entry({ dictionary: "terra_pinyin", dependencies: ["stroke"] });
    expect(() => deployed(all, wrong)).toThrow(
      "luna_pinyin: the table's dictionary is terra_pinyin, the deployed config's luna_pinyin",
    );
    wrong.table["luna_pinyin"] = entry({ dictionary: "luna_pinyin", dependencies: [] });
    expect(() => deployed(all, wrong)).toThrow(
      "luna_pinyin: the table's dependencies are [], the deployed config's [stroke]",
    );
    const missing = plan([]);
    delete missing.table["stroke"];
    expect(() => deployed(all, missing)).toThrow("stroke: deployed but not in the table");
  });
});

describe("dependencies", () => {
  const schemas = deployed(all, plan([]));

  test("resolve transitively, each once, the schema first", () => {
    expect(closure("jyut6ping3", schemas).map((schema) => schema.id)).toEqual(["jyut6ping3", "luna_pinyin", "stroke"]);
  });

  test("include what a schema needs without declaring it", () => {
    expect(closure("array30", schemas, { array30: ["array30_query"] }).map((schema) => schema.id)).toEqual([
      "array30",
      "array30_query",
    ]);
  });

  test("fail when one isn't deployed", () => {
    expect(() => closure("rime_ice", deployed([ice, melt], plan([])))).toThrow(
      "rime_ice: depends on radical_pinyin, which isn't deployed",
    );
  });

  test("become the engine's dictionaries' store paths", () => {
    expect(engineData("rime_ice", schemas, plan([]))).toEqual([
      "/nix/store/rime_ice",
      "/nix/store/melt_eng",
      "/nix/store/radical_pinyin",
    ]);
    expect(engineData("array30", schemas, plan([]))).toEqual(["/nix/store/array30", "/nix/store/array30_query"]);
  });
});

describe("descriptors", () => {
  test("name the schema and gloss it, typing on the US layout", () => {
    expect(engineDescriptor(ice, entry({ gloss: "Pinyin, simplified" }))).toEqual({
      name: "rime:rime_ice",
      displayName: "雾凇拼音 (Pinyin, simplified)",
      languages: ["zh-Hans"],
      keyboard: { layout: "us", passThrough: [] },
    });
  });

  test("fail without a gloss", () => {
    expect(() => engineDescriptor(ice, entry({ gloss: "" }))).toThrow("rime_ice: no gloss");
  });

  test("keep the order the schemas are listed in, and fail for one not deployed", () => {
    expect(generate(all, plan(["rime_ice", "luna_pinyin", "jyut6ping3"])).engines.map((e) => e.name)).toEqual([
      "rime:rime_ice",
      "rime:luna_pinyin",
      "rime:jyut6ping3",
    ]);
    expect(() => generate(all, plan(["rime_ice", "wubi86"]))).toThrow("wubi86: isn't deployed");
    expect(() => generate(all, plan(["rime_ice", "rime_ice"]))).toThrow("a schema is listed twice");
  });
});

describe("the module's tables", () => {
  test("find the switches the settings set, by index, and an option in a group", () => {
    expect(settingSwitchesOf(ice)).toEqual([
      { schema: "rime_ice", name: "ascii_punct", index: 1, option: -1 },
      { schema: "rime_ice", name: "traditionalization", index: 2, option: -1 },
      { schema: "rime_ice", name: "full_shape", index: 3, option: -1 },
    ]);
    expect(settingSwitchesOf(jyut)).toEqual([{ schema: "jyut6ping3", name: "simplification", index: 1, option: 2 }]);
  });

  test("give the schemas, switches and rime-ice's algebra as C", () => {
    const text = header([ice, luna], plan([]));
    expect(text).toContain('#define IBUSWEB_RIME_SCHEMAS(X) \\\n  X("rime_ice") \\\n  X("luna_pinyin")\n');
    expect(text).toContain('  X("luna_pinyin", "simplification", 2, -1)');
    expect(text).toContain('  X("rime_ice", "erase/^hm$/") \\\n  X("rime_ice", "xform/\\"/\\\\\\\\/")\n');
    const algebra = text.slice(text.indexOf("#define IBUSWEB_RIME_ALGEBRA"));
    expect(algebra).not.toContain("luna_pinyin");
  });

  test("refuse a control character", () => {
    expect(() => header([raw("x\u0001")], plan([]))).toThrow("control character");
  });
});

test("instances list the fixed schemas, then each engine's path", () => {
  expect(instances(generate(all, plan(["rime_ice", "luna_pinyin"])))).toBe(
    [
      "org.freedesktop.ibus.engine.rime",
      "org.freedesktop.ibus.panel",
      "org.freedesktop.ibus.engine.rime.schema=/org/freedesktop/ibus/engine/rime/rime_ice/",
      "org.freedesktop.ibus.engine.rime.schema=/org/freedesktop/ibus/engine/rime/luna_pinyin/",
      "",
    ].join("\n"),
  );
});
