// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { EngineDescriptor } from "./descriptors.ts";

const directory = process.env["IBUS_WEB_M17N_DESCRIPTORS"];
if (!directory) throw new Error("IBUS_WEB_M17N_DESCRIPTORS is required");
const read = (name: string) => readFileSync(join(directory, name), "utf8");

const engines: EngineDescriptor[] = JSON.parse(read("engines.json"));
const paths: Record<string, string[]> = JSON.parse(read("settings-paths.json"));
const schemas: string[] = JSON.parse(read("settings-schemas.json"));
const gschema = read("schemas/org.freedesktop.ibus.engine.m17n.variables.gschema.xml");

test("lists the 197 engines ibus-m17n does, the default first", () => {
  expect(engines).toHaveLength(197);
  expect(engines[0]!.name).toBe("m17n:t:latn-post");
  expect(new Set(engines.map((engine) => engine.name)).size).toBe(197);
  expect(engines.find((engine) => engine.name === "m17n:hi:inscript")).toEqual({
    name: "m17n:hi:inscript",
    displayName: "Hindi (inscript)",
    languages: ["hi"],
    keyboard: { layout: "default", passThrough: [] },
  });
});

test("leaves out what ranks below zero and what needs a plugin", () => {
  const names = new Set(engines.map((engine) => engine.name));
  for (const name of ["m17n:zh:py", "m17n:ko:han2", "m17n:ko:romaja", "m17n:ja:anthy", "m17n:en:ispell"])
    expect(names.has(name)).toBe(false);
});

test("gives every engine its own settings path", () => {
  const relocated = paths["org.freedesktop.ibus.engine.m17n"]!;
  expect(relocated).toHaveLength(197);
  expect(new Set(relocated).size).toBe(197);
  expect(relocated).toContain("/org/freedesktop/ibus/engine/m17n/sa/IAST/");
});

test("declares a variable schema for each of the 34 engines with variables", () => {
  expect(schemas.slice(0, 2)).toEqual(["org.freedesktop.ibus.engine.m17n", "org.freedesktop.ibus.panel"]);
  expect(schemas).toHaveLength(36);
  expect(schemas).toContain("org.freedesktop.ibus.engine.m17n.vi.telex");
  expect(schemas).toContain("org.freedesktop.ibus.engine.m17n.zh.cangjie");
  expect(gschema.match(/<key /g)).toHaveLength(53);
  expect(gschema).toContain(
    '<schema id="org.freedesktop.ibus.engine.m17n.th.kesmanee" path="/org/freedesktop/ibus/engine/m17n/th/kesmanee/variables/">',
  );
});

test("lists every instance for test harnesses", () => {
  const lines = read("instances.txt").trimEnd().split("\n");
  expect(lines).toHaveLength(35 + 197);
  expect(lines).toContain("org.freedesktop.ibus.engine.m17n.vi.telex");
  expect(lines).toContain("org.freedesktop.ibus.engine.m17n=/org/freedesktop/ibus/engine/m17n/hi/inscript/");
});
