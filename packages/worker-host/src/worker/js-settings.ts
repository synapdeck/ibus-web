// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A JavaScript module's settings, kept by the host as a GSettings backend
// keeps them: each engine's declared keys at the instance its schema id
// names, holding what Init, the page's changes and the engines' writes store
// there. Each refusal is warned of in the words the page hears for any
// module's settings.

import { variant, type GVariantValue, type Init } from "@ibus-web/protocol";
import type { ModuleScript, SettingDeclaration, SettingType, SettingValue } from "@ibus-web/protocol/module-script";

type Variant = Extract<GVariantValue, { _tag: "v" }>;

interface Schema {
  readonly id: string;
  readonly engine: string;
  readonly path: string;
  readonly keys: Readonly<Record<string, SettingDeclaration>>;
  // A key without a value has its default.
  readonly values: Map<string, SettingValue>;
}

/** A key's stored value that differs from the one before. */
export interface SettingChange {
  readonly engine: string;
  readonly key: string;
  readonly value: SettingValue;
}

/** What the page's change of a key does to the store. */
export type ChangeResult =
  | { readonly _tag: "Stored"; readonly change: SettingChange | undefined }
  | { readonly _tag: "Unknown" }
  | { readonly _tag: "Invalid" };

/** An engine's write, for the page to persist. */
export interface Written {
  readonly path: string;
  readonly value: Variant;
  readonly change: SettingChange | undefined;
}

// GSettings' own rule for a path: absolute, a directory, no empty component.
const pathValid = (path: string): boolean => path.startsWith("/") && path.endsWith("/") && !path.includes("//");

const patternValid = (pattern: string): boolean =>
  pathValid(pattern) && /^(?:[^{}]|\{[A-Za-z0-9_-]+\})*$/.test(pattern) && pattern.includes("{");

const int32 = (value: number): boolean => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;

const inRange = (declaration: { readonly range?: { min: number; max: number } }, value: number): boolean =>
  declaration.range === undefined || (value >= declaration.range.min && value <= declaration.range.max);

// GVariant strings are UTF-8 without NUL, and a lone surrogate has no
// encoding in UTF-8.
export const wellFormed = (value: unknown): value is string => typeof value === "string" && !/[\0\p{Cs}]/u.test(value);

// Whether value is one of the key's: of its type, and within its choices or
// range.
const accepts = (declaration: SettingDeclaration, value: unknown): value is SettingValue => {
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

// The plain value a variant of the key's type holds, or undefined for a
// variant of another type.
const plain = (type: SettingType, boxed: Variant): unknown => {
  const { value } = boxed;
  if (boxed.type !== type) return undefined;
  if (value._tag !== "a") return value._tag === type && "value" in value ? value.value : undefined;

  const items: unknown[] = [];
  for (const item of value.items) {
    if (item._tag !== "s") return undefined;
    items.push(item.value);
  }
  return Object.freeze(items);
};

const boxed = (type: SettingType, value: SettingValue): Variant =>
  typeof value === "object"
    ? variant(type, { _tag: "a", items: value.map((item) => ({ _tag: "s", value: item })) })
    : variant(type, { _tag: type, value } as GVariantValue);

const equal = (a: SettingValue, b: SettingValue): boolean =>
  typeof a === "object" && typeof b === "object"
    ? a.length === b.length && a.every((item, index) => item === b[index])
    : Object.is(a, b);

const describe = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return typeof value;
  }
};

const settingTypes: ReadonlySet<unknown> = new Set<SettingType>(["b", "s", "i", "d", "as"]);

// What is wrong with a script's declaration of a key, which the start
// refuses, or undefined for a sound one: of a known type, with a range of
// that type's numbers, choices that are strings, and a default those allow.
export const declarationProblem = (declaration: unknown): string | undefined => {
  if (typeof declaration !== "object" || declaration === null) return "isn't a declaration";

  const { type, range, choices, summary, description, default: initial } = declaration as Record<string, unknown>;
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

  if (!accepts(declaration as SettingDeclaration, initial))
    return `has the default ${describe(initial)}, which it doesn't accept`;
  return undefined;
};

export const settingsStore = (script: ModuleScript, warn: (message: string) => void) => {
  const schemas = new Map<string, Schema>();
  const byEngine = new Map<string, Schema>();
  for (const [engine, { settings }] of Object.entries(script.engines)) {
    if (settings === undefined) continue;

    // A list's default is handed to the engines, so it is a frozen copy the
    // script's own array can't change.
    const keys = Object.fromEntries(
      Object.entries(settings).map(([key, declaration]) => [
        key,
        declaration.type === "as" ? { ...declaration, default: Object.freeze([...declaration.default]) } : declaration,
      ]),
    );
    const id = `${script.settingsPrefix}.${engine}`;
    const schema = { id, engine, path: `/${id.split(".").join("/")}/`, keys, values: new Map() };
    schemas.set(id, schema);
    byEngine.set(engine, schema);
  }

  // The instances Init declared, by path. Only these hold values.
  const declared = new Map<string, Schema>();

  const declaration = (schema: Schema, key: string): SettingDeclaration | undefined =>
    Object.hasOwn(schema.keys, key) ? schema.keys[key] : undefined;

  const store = (schema: Schema, key: string, value: SettingValue): SettingChange | undefined => {
    const old = schema.values.get(key) ?? schema.keys[key]!.default;
    schema.values.set(key, value);
    return equal(old, value) ? undefined : { engine: schema.engine, key, value };
  };

  // The key at a declared path and a value for it, or undefined after a
  // warning.
  const resolve = (path: string, key: string): { schema: Schema; declaration: SettingDeclaration } | undefined => {
    const schema = declared.get(path);
    if (schema === undefined) {
      warn(`Unknown settings path: ${path}`);
      return undefined;
    }

    const found = declaration(schema, key);
    if (found === undefined) {
      warn(`Unknown settings key: ${path}${key}`);
      return undefined;
    }
    return { schema, declaration: found };
  };

  const valueOf = (path: string, key: string, declaration: SettingDeclaration, value: Variant) => {
    const candidate = plain(declaration.type, value);
    if (accepts(declaration, candidate)) return candidate;

    warn(`Invalid value for settings key: ${path}${key}`);
    return undefined;
  };

  // The engine's schema and the key's declaration, or a throw into the
  // engine that named a key it doesn't declare.
  const own = (engine: string, key: string) => {
    const schema = byEngine.get(engine);
    const found = schema && declaration(schema, key);
    if (found === undefined) throw new Error(`engine ${engine} has no setting ${key}`);

    return { schema: schema!, declaration: found };
  };

  return {
    // Every schema of a JavaScript module has a fixed path, so a pattern is
    // always refused.
    init: ({ settings, patterns }: Pick<Init, "settings" | "patterns">): void => {
      for (const { schemaId, pattern } of patterns) {
        const schema = schemas.get(schemaId);
        if (schema === undefined) warn(`Unknown settings schema: ${schemaId}`);
        else if (!patternValid(pattern)) warn(`Invalid settings pattern: ${pattern}`);
        else warn(`Settings schema ${schemaId} has the fixed path ${schema.path}, not a pattern`);
      }

      for (const { schemaId, path, values } of settings) {
        const schema = schemas.get(schemaId);
        if (schema === undefined) {
          warn(`Unknown settings schema: ${schemaId}`);
          continue;
        }
        if (!pathValid(path)) {
          warn(`Invalid settings path: ${path}`);
          continue;
        }
        if (path !== schema.path) {
          warn(`Settings schema ${schemaId} has the fixed path ${schema.path}, not ${path}`);
          continue;
        }

        declared.set(path, schema);
        for (const [key, value] of Object.entries(values)) {
          const resolved = resolve(path, key);
          const accepted = resolved && valueOf(path, key, resolved.declaration, value);
          if (accepted !== undefined) store(schema, key, accepted);
        }
      }
    },

    change: (path: string, key: string, value: Variant): ChangeResult => {
      const resolved = resolve(path, key);
      if (resolved === undefined) return { _tag: "Unknown" };

      const accepted = valueOf(path, key, resolved.declaration, value);
      if (accepted === undefined) return { _tag: "Invalid" };

      return { _tag: "Stored", change: store(resolved.schema, key, accepted) };
    },

    get: (engine: string, key: string): SettingValue => {
      const { schema, declaration } = own(engine, key);
      return schema.values.get(key) ?? declaration.default;
    },

    // Undefined, after a warning, for an instance Init didn't declare.
    set: (engine: string, key: string, value: SettingValue): Written | undefined => {
      const { schema, declaration } = own(engine, key);
      if (!accepts(declaration, value))
        throw new TypeError(`setting ${key} of engine ${engine} can't hold ${describe(value)}`);
      if (declared.get(schema.path) !== schema) {
        warn(`Unknown settings path: ${schema.path}${key}`);
        return undefined;
      }

      const stored = typeof value === "object" ? Object.freeze([...value]) : value;
      return { path: schema.path, value: boxed(declaration.type, stored), change: store(schema, key, stored) };
    },
  };
};
