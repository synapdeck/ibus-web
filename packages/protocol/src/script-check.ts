// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A module script's default export checked against the contract alone, as
// both the host's start and a module's build check it before either compares
// it with a manifest.

import { MODULE_ABI, type ModuleScript, type SettingDeclaration, type SettingValue } from "./module-script.ts";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const describe = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return typeof value;
  }
};

const int32 = (value: number): boolean => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;

const inRange = (declaration: { readonly range?: { min: number; max: number } }, value: number): boolean =>
  declaration.range === undefined || (value >= declaration.range.min && value <= declaration.range.max);

/** Whether a value is a string a record can carry: GVariant strings are UTF-8 without NUL, and a lone surrogate has no encoding in UTF-8. */
export const wellFormed = (value: unknown): value is string => typeof value === "string" && !/[\0\p{Cs}]/u.test(value);

/** Whether a value is one of a setting's: of its type, and within its choices or range. */
export const settingAccepts = (declaration: SettingDeclaration, value: unknown): value is SettingValue => {
  switch (declaration.type) {
    case "b":
      return typeof value === "boolean";
    case "s":
      return wellFormed(value) && (declaration.choices === undefined || declaration.choices.includes(value));
    case "i":
      return typeof value === "number" && int32(value) && inRange(declaration, value);
    case "d":
      return typeof value === "number" && inRange(declaration, value);
    case "as":
      return Array.isArray(value) && value.every(wellFormed);
    default:
      return false;
  }
};

const settingTypes: ReadonlySet<unknown> = new Set(["b", "s", "i", "d", "as"]);

/**
 * What is wrong with a script's declaration of a setting, or undefined for a sound one: of a known type, with a range
 * of that type's numbers, choices that are strings, and a default those allow.
 */
export const declarationProblem = (declaration: unknown): string | undefined => {
  if (!isObject(declaration)) return "isn't a declaration";

  const { type, range, choices, summary, description, default: initial } = declaration;
  if (!settingTypes.has(type)) return `has the unknown type ${describe(type)}`;

  if (range !== undefined) {
    const { min, max } = (range ?? {}) as Record<string, unknown>;
    const bound = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value) && (type !== "i" || int32(value));
    if ((type !== "i" && type !== "d") || !bound(min) || !bound(max) || min > max)
      return `has the range ${describe(range)}, which isn't one of its type's`;
  }
  if (choices !== undefined && (type !== "s" || !Array.isArray(choices) || !choices.every(wellFormed)))
    return `has the choices ${describe(choices)}, which aren't strings of its type`;
  if ((summary !== undefined && !wellFormed(summary)) || (description !== undefined && !wellFormed(description)))
    return "has a summary or description that isn't text";

  if (!settingAccepts(declaration as unknown as SettingDeclaration, initial))
    return `has the default ${describe(initial)}, which it doesn't accept`;
  return undefined;
};

// An object enumerates these first, in numeric order, whatever order the
// script wrote them in, so the engines' order can't be read from it.
const isArrayIndex = (name: string): boolean => /^(?:0|[1-9][0-9]*)$/.test(name) && Number(name) < 2 ** 32 - 1;

// Dot-separated components, each one a component of the schemas' paths.
const prefixValid = (prefix: string): boolean => /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(prefix);

/** Why a default export isn't a sound module script. */
export type ScriptProblem =
  | { readonly _tag: "NotAModule" }
  | { readonly _tag: "ModuleAbiMismatch"; readonly abi: unknown }
  | { readonly _tag: "Unsound"; readonly reason: string };

/**
 * What is wrong with a default export by the contract, or undefined for a module script: the `ibusWebModule` brand
 * of this contract's version, `persist` and `shutdown` functions where present, engines none of which is named as an
 * array index, each with a `create` function, and settings under a `settingsPrefix` that can start a schema id, each
 * named with text a record can carry and soundly declared.
 */
export const scriptProblem = (exported: unknown): ScriptProblem | undefined => {
  const unsound = (reason: string): ScriptProblem => ({ _tag: "Unsound", reason });

  if (!isObject(exported) || !("ibusWebModule" in exported)) return { _tag: "NotAModule" };
  const { ibusWebModule, engines, settingsPrefix } = exported;
  if (ibusWebModule !== MODULE_ABI) return { _tag: "ModuleAbiMismatch", abi: ibusWebModule };

  for (const hook of ["persist", "shutdown"])
    if (exported[hook] !== undefined && typeof exported[hook] !== "function")
      return unsound(`its ${hook} isn't a function`);
  if (!isObject(engines)) return unsound("it has no engines");

  const indexed = Object.keys(engines).find(isArrayIndex);
  if (indexed !== undefined) return unsound(`its engine ${indexed} is named as an array index, which has no order`);

  if (settingsPrefix !== undefined && (typeof settingsPrefix !== "string" || !prefixValid(settingsPrefix)))
    return unsound(`its settingsPrefix ${JSON.stringify(settingsPrefix)} can't start a schema id`);

  for (const [name, engine] of Object.entries(engines)) {
    if (!isObject(engine) || typeof engine["create"] !== "function")
      return unsound(`its engine ${name} has no create function`);

    const settings = engine["settings"];
    if (settings === undefined) continue;

    if (!isObject(settings) || Array.isArray(settings))
      return unsound(`its engine ${name}'s settings aren't keys by name`);
    if (settingsPrefix === undefined)
      return unsound(`its engine ${name} declares settings, but the module has no settingsPrefix`);
    for (const [key, declaration] of Object.entries(settings)) {
      if (key === "" || !wellFormed(key))
        return unsound(`its engine ${name} has a setting named ${JSON.stringify(key)}, which no record can carry`);

      const problem = declarationProblem(declaration);
      if (problem !== undefined) return unsound(`its engine ${name}'s setting ${key} ${problem}`);
    }
  }
  return undefined;
};

/** The settings schema ids of a sound module script's engines with settings, `<settingsPrefix>.<engine>`, in its order. */
export const settingsSchemaIds = (script: ModuleScript): string[] =>
  Object.entries(script.engines).flatMap(([name, { settings }]) =>
    settings === undefined ? [] : [`${script.settingsPrefix}.${name}`],
  );

/** A settings schema's path: its id's components joined by `/`. */
export const settingsSchemaPath = (id: string): string => `/${id.split(".").join("/")}/`;
