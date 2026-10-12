// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { EngineDescriptor } from "./descriptors.ts";

const read = (directory: string, name: string) => readFileSync(join(directory, name), "utf8");

const builds = {
  every: process.env["IBUS_WEB_RIME_DESCRIPTORS"],
  fewer: process.env["IBUS_WEB_RIME_DESCRIPTORS_FEWER"],
};
for (const [build, directory] of Object.entries(builds))
  if (!directory) throw new Error(`the ${build} build's descriptors are required`);

const every = builds.every!;
const fewer = builds.fewer!;

describe("the default build", () => {
  const engines: EngineDescriptor[] = JSON.parse(read(every, "engines.json"));
  const data: Record<string, string[]> = JSON.parse(read(every, "engine-data.json"));

  test("lists every schema's engine, the mainstream ones first", () => {
    expect(engines).toHaveLength(47);
    expect(engines.slice(0, 3).map((engine) => engine.name)).toEqual([
      "rime:rime_ice",
      "rime:double_pinyin",
      "rime:double_pinyin_flypy",
    ]);
    expect(engines[16]!.name).toBe("rime:wugniu");
    expect(engines[17]!.name).toBe("rime:array30");
    expect(engines[0]).toEqual({
      name: "rime:rime_ice",
      displayName: "雾凇拼音 (Pinyin, simplified)",
      languages: ["zh-Hans"],
      keyboard: { layout: "us", passThrough: [] },
    });
    for (const name of ["rime:loengfan", "rime:melt_eng", "rime:radical_pinyin", "rime:array30_query", "rime:t9"])
      expect(engines.map((engine) => engine.name)).not.toContain(name);
  });

  test("gives each engine its dictionaries and its dependencies'", () => {
    const names = (engine: string) =>
      data[engine]!.map((path) => path.replace(/^\/nix\/store\/[0-9a-z]{32}-ibus-web-rime-dict-/, ""));
    expect(names("rime:rime_ice")).toEqual(["rime_ice", "melt_eng", "radical_pinyin"]);
    expect(names("rime:cangjie5")).toEqual(["cangjie5", "luna_pinyin", "stroke"]);
    expect(names("rime:jyut6ping3")).toEqual(["jyut6ping3", "luna_pinyin", "stroke", "loengfan", "cangjie5"]);
    expect(names("rime:array30")).toEqual(["array30", "array30_wsymbols", "luna_pinyin", "stroke", "array30_query"]);
  });
});

test("a build with fewer schemas lists only those, with the dependencies' data", () => {
  const engines: EngineDescriptor[] = JSON.parse(read(fewer, "engines.json"));
  expect(engines.map((engine) => engine.name)).toEqual(["rime:rime_ice", "rime:luna_pinyin", "rime:jyut6ping3"]);
  const data: Record<string, string[]> = JSON.parse(read(fewer, "engine-data.json"));
  expect(Object.keys(data)).toEqual(["rime:rime_ice", "rime:luna_pinyin", "rime:jyut6ping3"]);
  expect(read(fewer, "rime-tables.h")).toContain(
    '#define IBUSWEB_RIME_SCHEMAS(X) \\\n  X("rime_ice") \\\n  X("luna_pinyin") \\\n  X("jyut6ping3")\n',
  );
});
