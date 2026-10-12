// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** One of a schema's switches, as the descriptor program prints it: a name for a toggle, options for a group. */
export interface RawSwitch {
  name: string;
  options: string[];
  states: string[];
}

/** One deployed schema, as the descriptor program prints it. */
export interface RawSchema {
  id: string;
  name: string;
  dictionary: string;
  dependencies: string[];
  switches: RawSwitch[];
  algebra: string[];
}

/** A schema's entry in the module's table. */
export interface TableEntry {
  gloss: string;
  languages: string[];
  from: "rime-data" | "rime-loengfan" | "rime-ice";
  engine?: boolean;
  undeclared?: string[];
  dictionary: string;
  dependencies: string[];
}

/** What the build knows before deploying: the schemas it ships, in order, its table and each dictionary's store path. */
export interface Plan {
  schemas: string[];
  table: Record<string, TableEntry>;
  dictionaries: Record<string, string>;
}

/** An engine descriptor, as `mkEngineManifest` takes it. */
export interface EngineDescriptor {
  name: string;
  displayName: string;
  languages: string[];
  keyboard: { layout: "us"; passThrough: string[] };
}

/** A switch the settings set: its index among the schema's switches, and the option's within it, or -1 for a toggle. */
export interface SettingSwitch {
  schema: string;
  name: string;
  index: number;
  option: number;
}

/** What the build takes from this step. */
export interface Outputs {
  engines: EngineDescriptor[];
  engineData: Record<string, string[]>;
  settingsPaths: Record<string, string[]>;
  settingsSchemas: string[];
  header: string;
}

export const fixedSchema = "org.freedesktop.ibus.engine.rime";
export const relocatableSchema = "org.freedesktop.ibus.engine.rime.schema";
export const panelSchema = "org.freedesktop.ibus.panel";

// The switches whose initial state the settings set.
const settingSwitches = ["full_shape", "ascii_punct", "simplification", "traditionalization"];

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export const settingsPath = (id: string) => `/org/freedesktop/ibus/engine/rime/${id}/`;

/** The deployed schemas by id, checked against the table, which the build trusted before it deployed. */
export function deployed(raw: readonly RawSchema[], plan: Plan): Map<string, RawSchema> {
  const schemas = new Map(raw.map((schema) => [schema.id, schema]));
  for (const schema of raw) {
    const entry = plan.table[schema.id];
    if (entry === undefined) throw new Error(`${schema.id}: deployed but not in the table`);
    if (entry.dictionary !== schema.dictionary)
      throw new Error(
        `${schema.id}: the table's dictionary is ${entry.dictionary}, the deployed config's ${schema.dictionary}`,
      );
    if (!same(entry.dependencies, schema.dependencies))
      throw new Error(
        `${schema.id}: the table's dependencies are [${entry.dependencies.join(", ")}], the deployed config's [${schema.dependencies.join(", ")}]`,
      );
  }
  return schemas;
}

/** A schema and, transitively, its dependencies, declared or not, each once, the schema first. */
export function closure(
  id: string,
  schemas: ReadonlyMap<string, RawSchema>,
  undeclared: Readonly<Record<string, string[]>> = {},
): RawSchema[] {
  const seen = new Map<string, RawSchema>();
  const visit = (current: string, from: string) => {
    if (seen.has(current)) return;
    const schema = schemas.get(current);
    if (schema === undefined) throw new Error(`${from}: depends on ${current}, which isn't deployed`);
    seen.set(current, schema);
    for (const dependency of [...schema.dependencies, ...(undeclared[current] ?? [])]) visit(dependency, current);
  };
  visit(id, id);
  return [...seen.values()];
}

export function engineDescriptor(schema: RawSchema, entry: TableEntry): EngineDescriptor {
  if (entry.gloss === "") throw new Error(`${schema.id}: no gloss`);
  return {
    name: `rime:${schema.id}`,
    displayName: `${schema.name} (${entry.gloss})`,
    languages: entry.languages,
    // The shape-based schemas map key positions, so every engine reads the
    // US layout's.
    keyboard: { layout: "us", passThrough: [] },
  };
}

/** The store paths of an engine's dictionaries: its own schema's, then its dependencies'. */
export function engineData(id: string, schemas: ReadonlyMap<string, RawSchema>, plan: Plan): string[] {
  const undeclared = Object.fromEntries(
    Object.entries(plan.table).map(([schema, entry]) => [schema, entry.undeclared ?? []]),
  );
  const paths = closure(id, schemas, undeclared).map((schema) => {
    const path = plan.dictionaries[schema.dictionary];
    if (path === undefined) throw new Error(`${schema.id}: no store path for dictionary ${schema.dictionary}`);
    return path;
  });
  return [...new Set(paths)];
}

export function settingSwitchesOf(schema: RawSchema): SettingSwitch[] {
  return schema.switches.flatMap((found, index): SettingSwitch[] => {
    if (found.name !== "")
      return settingSwitches.includes(found.name) ? [{ schema: schema.id, name: found.name, index, option: -1 }] : [];
    const option = found.options.indexOf("simplification");
    return option < 0 ? [] : [{ schema: schema.id, name: "simplification", index, option }];
  });
}

/** rime-ice's Pinyin and Double Pinyin schemas, which take fuzzy Pinyin before their own algebra. */
export const isRimeIcePinyin = (schema: RawSchema, plan: Plan) =>
  plan.table[schema.id]?.from === "rime-ice" && schema.dictionary === "rime_ice";

// JSON's escapes are C's for the text a schema holds: its quotes,
// backslashes and non-ASCII characters, but no control characters.
const cString = (text: string) => {
  if ([...text].some((character) => character.codePointAt(0)! < 0x20))
    throw new Error(`control character in ${JSON.stringify(text)}`);
  return JSON.stringify(text);
};

const macro = (name: string, entries: readonly string[]) =>
  entries.length === 0
    ? `#define ${name}(X)`
    : [`#define ${name}(X) \\`, entries.map((entry) => `  ${entry}`).join(" \\\n")].join("\n");

/** The tables the module compiles in: its engines' schemas, the switches its settings set, and the algebra fuzzy Pinyin goes before. */
export function header(shipped: readonly RawSchema[], plan: Plan): string {
  const switches = shipped.flatMap(settingSwitchesOf);
  const algebra = shipped
    .filter((schema) => isRimeIcePinyin(schema, plan))
    .flatMap((schema) => schema.algebra.map((rule) => `X(${cString(schema.id)}, ${cString(rule)})`));
  return [
    macro(
      "IBUSWEB_RIME_SCHEMAS",
      shipped.map((schema) => `X(${cString(schema.id)})`),
    ),
    macro(
      "IBUSWEB_RIME_SWITCHES",
      switches.map((found) => `X(${cString(found.schema)}, ${cString(found.name)}, ${found.index}, ${found.option})`),
    ),
    macro("IBUSWEB_RIME_ALGEBRA", algebra),
    "",
  ].join("\n");
}

/**
 * Each schema instance the module declares, one a line, as the metadata tool
 * takes them: a fixed schema's id, or the relocatable schema's id and a path.
 */
export function instances(outputs: Outputs): string {
  const fixed = outputs.settingsSchemas.filter((id) => id !== relocatableSchema);
  const relocated = Object.entries(outputs.settingsPaths).flatMap(([id, paths]) =>
    paths.map((path) => `${id}=${path}`),
  );
  return [...fixed, ...relocated, ""].join("\n");
}

export function generate(raw: readonly RawSchema[], plan: Plan): Outputs {
  const schemas = deployed(raw, plan);
  if (new Set(plan.schemas).size !== plan.schemas.length) throw new Error("a schema is listed twice");
  const shipped = plan.schemas.map((id) => {
    const schema = schemas.get(id);
    if (schema === undefined) throw new Error(`${id}: isn't deployed`);
    return schema;
  });

  return {
    engines: shipped.map((schema) => engineDescriptor(schema, plan.table[schema.id]!)),
    engineData: Object.fromEntries(
      shipped.map((schema) => [`rime:${schema.id}`, engineData(schema.id, schemas, plan)]),
    ),
    settingsPaths: { [relocatableSchema]: shipped.map((schema) => settingsPath(schema.id)) },
    settingsSchemas: [fixedSchema, relocatableSchema, panelSchema],
    header: header(shipped, plan),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, planFile, output] = process.argv.slice(2);
  if (!input || !planFile || !output) throw new Error("usage: descriptors.ts RAW.json PLAN.json OUTPUT_DIR");
  const outputs = generate(JSON.parse(readFileSync(input, "utf8")), JSON.parse(readFileSync(planFile, "utf8")));

  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "engines.json"), json(outputs.engines));
  writeFileSync(join(output, "engine-data.json"), json(outputs.engineData));
  writeFileSync(join(output, "settings-paths.json"), json(outputs.settingsPaths));
  writeFileSync(join(output, "settings-schemas.json"), json(outputs.settingsSchemas));
  writeFileSync(join(output, "rime-tables.h"), outputs.header);
  writeFileSync(join(output, "instances.txt"), instances(outputs));
}
