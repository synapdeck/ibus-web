// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-2.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** A variable's value as m17n gives it: an integer, a symbol's name or a text. */
export type RawValue = number | string;

/** One input-method variable, as the descriptor program prints it. */
export interface RawVariable {
  name: string;
  description: string | null;
  type: "integer" | "symbol" | "text" | null;
  value: RawValue | null;
  valid: Array<RawValue | { min: number; max: number }>;
}

/** One engine ibus-m17n lists, as the descriptor program prints it. */
export interface RawEngine {
  name: string;
  language: string;
  inputMethod: string;
  rank: number;
  layout: string;
  variables: RawVariable[];
}

/** An engine descriptor, as `mkEngineManifest` takes it. */
export interface EngineDescriptor {
  name: string;
  displayName: string;
  languages: string[];
  keyboard: { layout: "default"; passThrough: string[] };
}

/** A key of a variable schema. */
export interface VariableKey {
  name: string;
  type: "integer" | "symbol" | "text";
  default: RawValue;
  description?: string;
  range?: { min: number; max: number };
  choices?: string[];
}

/** The fixed-path schema holding one input method's variables. */
export interface VariableSchema {
  id: string;
  path: string;
  language: string;
  inputMethod: string;
  keys: VariableKey[];
}

/** What the build takes from this step. */
export interface Outputs {
  engines: EngineDescriptor[];
  settingsPaths: Record<string, string[]>;
  settingsSchemas: string[];
  gschema: string;
  header: string;
}

export const relocatableSchema = "org.freedesktop.ibus.engine.m17n";
export const panelSchema = "org.freedesktop.ibus.panel";

// ISO 639 collective and minority codes that ICU has no English name for,
// with their ISO 639 reference names.
const languageNames: Record<string, string> = {
  ath: "Athapascan",
  cmc: "Chamic",
  dra: "Dravidian",
  nsk: "Naskapi",
  tai: "Tai",
};

const displayNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

// GLib's rule for key names: a lowercase letter, then lowercase letters,
// digits and single hyphens, not ending in a hyphen.
const keyName = /^[a-z](?:-?[a-z0-9])*$/;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** m17n's `t` is no language: its methods work for any text. */
const isGeneral = (engine: RawEngine) => engine.language === "t";

export function displayName(engine: RawEngine): string {
  if (isGeneral(engine)) return engine.inputMethod;
  const language = displayNames.of(engine.language) ?? languageNames[engine.language];
  if (language === undefined) throw new Error(`${engine.name}: no English name for language ${engine.language}`);
  return `${language} (${engine.inputMethod})`;
}

/**
 * The path ibus-m17n opens the engine's settings at. It builds the path from
 * the engine's GType name, which lowercases the input method's name, and
 * retries an all-uppercase name (sa:IAST) as it is when m17n has no input
 * method by the lowercased one.
 */
export function settingsPath(engine: RawEngine): string {
  const name = engine.inputMethod;
  const kept = name === name.toUpperCase() ? name : name.toLowerCase();
  return `/org/freedesktop/ibus/engine/m17n/${engine.language.toLowerCase()}/${kept}/`;
}

/** The default first, then by language and the input method's name. */
export function sortEngines(raw: readonly RawEngine[], defaultEngine: string): RawEngine[] {
  const first = raw.find((engine) => engine.name === defaultEngine);
  if (first === undefined) throw new Error(`the default engine ${defaultEngine} isn't listed`);

  const rest = raw
    .filter((engine) => engine !== first)
    .sort((a, b) => compare(a.language, b.language) || compare(a.inputMethod, b.inputMethod));
  return [first, ...rest];
}

export function engineDescriptor(engine: RawEngine): EngineDescriptor {
  // m17n's layouts are the keyboard as it is, sometimes with AltGr as a
  // third-level switch, which the page's "default" keyboard already is.
  if (engine.layout !== "default" && !engine.layout.startsWith("default["))
    throw new Error(`${engine.name}: unexpected layout ${engine.layout}`);

  return {
    name: engine.name,
    displayName: displayName(engine),
    languages: isGeneral(engine) ? [] : [engine.language],
    keyboard: { layout: "default", passThrough: [] },
  };
}

function integerRange(variable: RawVariable, engine: RawEngine): { min: number; max: number } | undefined {
  if (variable.valid.length === 0) return undefined;
  const ranges = variable.valid.filter((valid): valid is { min: number; max: number } => typeof valid === "object");
  if (ranges.length === 1 && variable.valid.length === 1) return ranges[0];

  const values = [...new Set(variable.valid)].map((valid) => {
    if (typeof valid !== "number") throw new Error(`${engine.name}: ${variable.name} mixes ranges and values`);
    return valid;
  });
  values.sort((a, b) => a - b);

  // GSettings constrains an integer only by a range, so the values have to
  // be one.
  if (values.some((value, index) => value !== values[0]! + index))
    throw new Error(`${engine.name}: ${variable.name}'s values ${values.join(" ")} aren't a range`);
  return { min: values[0]!, max: values.at(-1)! };
}

export function variableKey(variable: RawVariable, engine: RawEngine): VariableKey {
  if (!keyName.test(variable.name) || variable.name.length > 1024)
    throw new Error(`${engine.name}: variable ${variable.name} isn't a valid GSettings key name`);
  if (variable.type === null || variable.value === null)
    throw new Error(`${engine.name}: variable ${variable.name} has no initial value`);

  const description = variable.description?.trim();
  const key: VariableKey = {
    name: variable.name,
    type: variable.type,
    default: variable.value,
    ...(description ? { description } : {}),
  };

  if (variable.type === "integer") {
    const range = integerRange(variable, engine);
    if (range === undefined) return key;
    if (typeof variable.value !== "number" || variable.value < range.min || variable.value > range.max)
      throw new Error(`${engine.name}: ${variable.name}'s default ${variable.value} is out of its range`);
    return { ...key, range };
  }
  if (variable.type === "symbol" && variable.valid.length > 0) {
    const choices = variable.valid.map(String);
    if (!choices.includes(String(variable.value)))
      throw new Error(`${engine.name}: ${variable.name}'s default ${variable.value} isn't one of its values`);
    return { ...key, choices };
  }
  return key;
}

export function variableSchema(engine: RawEngine): VariableSchema {
  return {
    id: `${relocatableSchema}.${engine.language}.${engine.inputMethod}`,
    path: `${settingsPath(engine)}variables/`,
    language: engine.language,
    inputMethod: engine.inputMethod,
    keys: engine.variables.map((variable) => variableKey(variable, engine)),
  };
}

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A string in GVariant's text format. */
const gvariantString = (text: string) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export function gschema(schemas: readonly VariableSchema[]): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<schemalist>"];
  for (const schema of schemas) {
    lines.push(`  <schema id="${xml(schema.id)}" path="${xml(schema.path)}">`);
    for (const key of schema.keys) {
      lines.push(`    <key name="${key.name}" type="${key.type === "integer" ? "i" : "s"}">`);
      if (key.range) lines.push(`      <range min="${key.range.min}" max="${key.range.max}"/>`);
      if (key.choices) {
        lines.push("      <choices>");
        for (const choice of key.choices) lines.push(`        <choice value="${xml(choice)}"/>`);
        lines.push("      </choices>");
      }
      const value = typeof key.default === "number" ? String(key.default) : gvariantString(key.default);
      lines.push(`      <default>${xml(value)}</default>`);
      if (key.description) lines.push(`      <description>${xml(key.description)}</description>`);
      lines.push("    </key>");
    }
    lines.push("  </schema>");
  }
  lines.push("</schemalist>", "");
  return lines.join("\n");
}

const cString = (text: string) => JSON.stringify(text);

/** The table variables.c applies the settings from, one entry per variable. */
export function header(schemas: readonly VariableSchema[]): string {
  const entries = schemas.flatMap((schema) =>
    schema.keys.map(
      (key) =>
        `  X(${cString(schema.language)}, ${cString(schema.inputMethod)}, ${cString(schema.id)}, ${cString(key.name)}, ${key.type.toUpperCase()})`,
    ),
  );
  return ["#define IBUSWEB_M17N_VARIABLES(X) \\", entries.join(" \\\n"), ""].join("\n");
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

export function generate(raw: readonly RawEngine[], defaultEngine: string): Outputs {
  const engines = sortEngines(raw, defaultEngine);
  const schemas = engines
    .filter((engine) => engine.variables.length > 0)
    .map(variableSchema)
    .sort((a, b) => compare(a.id, b.id));

  const paths = engines.map(settingsPath);
  if (new Set(paths).size !== paths.length) throw new Error("two engines share a settings path");

  return {
    engines: engines.map(engineDescriptor),
    settingsPaths: { [relocatableSchema]: paths },
    settingsSchemas: [relocatableSchema, panelSchema, ...schemas.map((schema) => schema.id)],
    gschema: gschema(schemas),
    header: header(schemas),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, defaultEngine, output] = process.argv.slice(2);
  if (!input || !defaultEngine || !output) throw new Error("usage: descriptors.ts RAW.json DEFAULT_ENGINE OUTPUT_DIR");
  const outputs = generate(JSON.parse(readFileSync(input, "utf8")), defaultEngine);

  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(join(output, "schemas"), { recursive: true });
  writeFileSync(join(output, "engines.json"), json(outputs.engines));
  writeFileSync(join(output, "settings-paths.json"), json(outputs.settingsPaths));
  writeFileSync(join(output, "settings-schemas.json"), json(outputs.settingsSchemas));
  writeFileSync(join(output, "schemas", `${relocatableSchema}.variables.gschema.xml`), outputs.gschema);
  writeFileSync(join(output, "variable-table.h"), outputs.header);
  writeFileSync(join(output, "instances.txt"), instances(outputs));
}
