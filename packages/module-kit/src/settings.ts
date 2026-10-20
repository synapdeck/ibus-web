// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { attributeTypes } from "@ibus-web/protocol/module-script";
import type * as Contract from "@ibus-web/protocol/module-script";
import { Schema, SchemaAST, SchemaRepresentation } from "effect";
import { ModuleDefinitionError } from "./errors.ts";

/** What a setting field's `property` annotation says about the property it is shown as. */
export interface SettingProperty {
  readonly label: Contract.RichText;
  readonly symbol?: Contract.RichText;
  /** A literals field's label for each of its values, which are the radios of its menu. */
  readonly values?: Readonly<Record<string, Contract.RichText>>;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      /** Makes a boolean setting a toggle property, and a literals setting a menu of radios. */
      readonly property?: SettingProperty;
    }
  }
}

/** An engine's settings: a struct with one field per setting, by camelCase name. */
export type SettingsSchema = Schema.Struct<Schema.Struct.Fields>;

/** The settings of an engine that declares none. */
export type NoSettings = Schema.Struct<{}>;

/** The names of the settings `S` declares. */
export type SettingName<S extends SettingsSchema> = keyof S["Type"] & string;

/** The GSettings key a camelCase setting name maps to: `vowelPoints` is `vowel-points`. */
export type GSettingsKey<K extends string> = K extends `${infer Head}${infer Tail}`
  ? `${Head extends Lowercase<Head> ? Head : `-${Lowercase<Head>}`}${GSettingsKey<Tail>}`
  : K;

/** The settings `S` declares as the contract has them, by GSettings key. */
export type SettingsDeclaration<S extends SettingsSchema> = {
  readonly [K in SettingName<S> as GSettingsKey<K>]: Contract.SettingDeclaration;
};

export const gsettingsKey = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export const settingName = (key: string): string => key.replace(/-(.)/g, (_, letter: string) => letter.toUpperCase());

// GSettings' rule for a key's name.
const keyPattern = /^[a-z](?:-?[a-z0-9])*$/;
const keyMaxLength = 32;

// A name maps to a key only if the key maps back to it, so that no two names
// share a key.
const nameMaps = (name: string): boolean => {
  const key = gsettingsKey(name);
  return key.length <= keyMaxLength && keyPattern.test(key) && settingName(key) === name;
};

const describe = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return typeof value;
  }
};

// GVariant strings are UTF-8 without NUL, and a lone surrogate has no
// encoding in UTF-8.
export const isText = (value: unknown): value is string => typeof value === "string" && !/[\0\p{Cs}]/u.test(value);

const isAttribute = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;

  const { type, value: argument, start, end } = value as Record<string, unknown>;
  return (
    (attributeTypes as readonly unknown[]).includes(type) &&
    Number.isInteger(argument) &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    (start as number) >= 0 &&
    (start as number) <= (end as number)
  );
};

// A property's text as the host carries it: text, or text with attributes.
const isRichText = (value: unknown): boolean =>
  isText(value) ||
  (typeof value === "object" &&
    value !== null &&
    isText((value as { text?: unknown }).text) &&
    Array.isArray((value as { attributes?: unknown }).attributes) &&
    (value as { attributes: unknown[] }).attributes.every(isAttribute));

const int32 = { min: -0x80000000, max: 0x7fffffff } as const;

const isInt32 = (value: number): boolean => Number.isInteger(value) && value >= int32.min && value <= int32.max;

// What is wrong with one field, which the struct's reader names the field in.
class Refused extends Error {}

const refuse = (why: string): never => {
  throw new Refused(why);
};

type JsonSchema = Readonly<Record<string, unknown>>;

// The JSON Schema of a schema's own value: references inlined, so that an
// identifier annotation changes nothing.
const jsonSchema = (ast: SchemaAST.AST): JsonSchema =>
  SchemaRepresentation.toJsonSchemaDocument(
    SchemaRepresentation.toRepresentation(ast, { referencePolicy: () => undefined }),
  ).schema as JsonSchema;

// Keys that describe a value rather than constrain it.
const annotationKeys = new Set(["title", "description", "default", "examples"]);

const constraints = (schema: JsonSchema): string[] => Object.keys(schema).filter((key) => !annotationKeys.has(key));

// A schema and each schema its allOf holds, in document order, without their
// allOf: a check JSON Schema keeps apart from the others, such as each of
// isInt32's, is one of them.
const fragmentsOf = (schema: JsonSchema): JsonSchema[] => {
  const { allOf, ...own } = schema;
  return [own, ...((allOf as JsonSchema[] | undefined) ?? []).flatMap(fragmentsOf)];
};

// The filters a schema's checks run, groups such as isInt32's opened.
const filters = (checks: readonly SchemaAST.Check<unknown>[]): SchemaAST.Filter<unknown>[] =>
  checks.flatMap((check) => (check._tag === "FilterGroup" ? filters(check.checks) : [check]));

// A filter JSON Schema can't express, such as a makeFilter predicate,
// vanishes from it, annotations and all, so it would never reach GSettings.
const isExpressible = (filter: SchemaAST.Filter<unknown>): boolean =>
  constraints(jsonSchema(Schema.Unknown.check(filter).ast)).length > 0;

// The schema and those it is made of that a setting can have checks on.
const members = (ast: SchemaAST.AST): SchemaAST.AST[] => {
  if (ast._tag === "Union") return [ast, ...ast.types.flatMap(members)];
  if (ast._tag === "Arrays") return [ast, ...ast.elements.flatMap(members), ...ast.rest.flatMap(members)];
  return [ast];
};

type Shape =
  | { readonly type: "b" | "s" | "as"; readonly choices?: readonly string[] }
  | { readonly type: "i" | "d"; readonly range?: Contract.SettingRange };

const unsupported = "isn't a Boolean, a String, Literals of strings, a Number or an integer, or an Array of String";

// Each member of a union of string literals is its own enum.
const literalChoices = (anyOf: unknown): unknown[] | undefined => {
  if (!Array.isArray(anyOf)) return undefined;

  const literals = anyOf as JsonSchema[];
  if (!literals.every((literal) => literal.type === "string" && Array.isArray(literal.enum))) return undefined;
  if (!literals.every((literal) => constraints(literal).length === 2)) return undefined;
  return literals.flatMap((literal) => literal.enum as unknown[]);
};

const allowed: Readonly<Record<string, ReadonlySet<string>>> = {
  boolean: new Set(["type"]),
  string: new Set(["type", "enum"]),
  integer: new Set(["type", "minimum", "maximum"]),
  number: new Set(["type", "minimum", "maximum"]),
  array: new Set(["type", "items"]),
};

// The setting's type, from the schema's own type and any its checks give it,
// as isInt gives a Number's. A Number's JSON Schema is a union, since JSON can
// spell NaN and the infinities only as strings, so its own type comes from
// its AST.
const typeOf = (ast: SchemaAST.AST, root: JsonSchema, fragments: readonly JsonSchema[]): string => {
  if (root.anyOf !== undefined) {
    if (SchemaAST.isNumber(ast)) return "number";
    if (literalChoices(root.anyOf) !== undefined) return "string";
    return refuse(unsupported);
  }

  const types = new Set(fragments.flatMap((fragment) => (fragment.type === undefined ? [] : [fragment.type])));
  if (types.size === 2 && types.has("number") && types.has("integer")) return "integer";

  const [type] = types;
  if (types.size !== 1 || typeof type !== "string" || allowed[type] === undefined) return refuse(unsupported);
  return type;
};

// An integer's range is within 32 bits, whether or not it has one of its
// own; a number has both bounds or none.
const rangeOf = (fragments: readonly JsonSchema[], integer: boolean): Contract.SettingRange | undefined => {
  const minima = fragments.flatMap((fragment) => (typeof fragment.minimum === "number" ? [fragment.minimum] : []));
  const maxima = fragments.flatMap((fragment) => (typeof fragment.maximum === "number" ? [fragment.maximum] : []));
  const min = minima.length === 0 ? undefined : Math.max(...minima);
  const max = maxima.length === 0 ? undefined : Math.min(...maxima);

  if (!integer && min === undefined && max === undefined) return undefined;
  if (!integer && (min === undefined || max === undefined))
    refuse(`has only a ${min === undefined ? "maximum" : "minimum"}, but a range needs both bounds`);
  if (min !== undefined && max !== undefined && min > max)
    refuse(`has the range ${min} to ${max}, which no value meets`);
  if (integer && !(isInt32(min ?? int32.min) && isInt32(max ?? int32.max)))
    refuse(`has the range ${min ?? int32.min} to ${max ?? int32.max}, beyond a 32-bit integer's`);
  return { min: min ?? int32.min, max: max ?? int32.max };
};

const choicesOf = (root: JsonSchema): readonly string[] => {
  const values = (root.enum as unknown[] | undefined) ?? literalChoices(root.anyOf)!;

  if (!values.every(isText)) refuse(`has the choices ${describe(values)}, which aren't all text`);
  if (new Set(values).size !== values.length) refuse(`has the choices ${describe(values)}, which repeat a value`);
  return values as string[];
};

// The GVariant type a field's JSON Schema maps to, and its range or choices.
const shapeOf = (ast: SchemaAST.AST, fragments: readonly JsonSchema[]): Shape => {
  const root = fragments[0]!;
  const type = typeOf(ast, root, fragments);

  for (const fragment of fragments)
    for (const key of constraints(fragment)) {
      if (key === "anyOf" && fragment === root) continue;
      if (key === "exclusiveMinimum" || key === "exclusiveMaximum")
        refuse("has an exclusive bound, which a GSettings range can't hold");
      if (key === "enum" && type !== "string") refuse("has choices that aren't strings");
      if (!allowed[type]!.has(key)) refuse(`has the JSON Schema constraint ${key}, which GSettings can't hold`);
    }

  switch (type) {
    case "boolean":
      return { type: "b" };
    case "string":
      return root.enum === undefined && root.anyOf === undefined
        ? { type: "s" }
        : { type: "s", choices: choicesOf(root) };
    case "integer":
      return { type: "i", range: rangeOf(fragments, true)! };
    case "number": {
      const range = rangeOf(fragments, false);
      return range === undefined ? { type: "d" } : { type: "d", range };
    }
    default: {
      const items = root.items as JsonSchema | undefined;
      if (items === undefined || items.type !== "string" || constraints(items).length !== 1)
        return refuse("is an array of other than unchecked String");
      return { type: "as" };
    }
  }
};

// Annotating a schema with checks annotates its last check, which JSON Schema
// may write apart from the schema's own annotations, so the last one written
// is the one given last.
const annotation = (fragments: readonly JsonSchema[], name: "default" | "title" | "description"): unknown =>
  fragments.findLast((fragment) => fragment[name] !== undefined)?.[name];

const textAnnotation = (fragments: readonly JsonSchema[], name: "title" | "description"): string | undefined => {
  const value = annotation(fragments, name);
  if (value !== undefined && !isText(value)) refuse(`has the ${name} ${describe(value)}, which isn't text`);
  return value as string | undefined;
};

// The contract's declaration of a field: its type, range or choices, its
// default, summary and description, all read from its JSON Schema.
const declarationOf = (field: Schema.Top): Contract.SettingDeclaration => {
  const { ast } = field;

  if (SchemaAST.isOptional(ast)) refuse("is optional, but a setting always has a value");
  if (ast.encoding !== undefined) refuse("transforms its value, which the store holds as it is");
  for (const member of members(ast))
    if (!filters(member.checks ?? []).every(isExpressible))
      refuse("has a check JSON Schema can't express, which GSettings can't either");

  const all = fragmentsOf(jsonSchema(ast));
  const shape = shapeOf(ast, all);
  const summary = textAnnotation(all, "title");
  const description = textAnnotation(all, "description");

  const initial = annotation(all, "default");
  if (initial === undefined) refuse("has no default annotation");
  if (!Schema.is(field)(initial)) refuse(`has the default ${describe(initial)}, which its schema rejects`);
  if ((shape.type === "s" && !isText(initial)) || (shape.type === "as" && !(initial as unknown[]).every(isText)))
    refuse(`has the default ${describe(initial)}, which isn't text`);
  // An integer's own schema may allow more than 32 bits do.
  if (
    "range" in shape &&
    shape.range !== undefined &&
    !((initial as number) >= shape.range.min && (initial as number) <= shape.range.max)
  )
    refuse(`has the default ${describe(initial)}, outside its range`);

  // A copy, so that the author changing their array afterwards changes no
  // declaration.
  return {
    ...shape,
    default: Array.isArray(initial) ? [...(initial as string[])] : initial,
    ...(summary === undefined ? {} : { summary }),
    ...(description === undefined ? {} : { description }),
  } as Contract.SettingDeclaration;
};

/** A setting that is also a property: a toggle, or a menu of one radio for each choice. */
export interface BoundSetting {
  readonly name: string;
  readonly key: string;
  readonly label: Contract.RichText;
  readonly symbol?: Contract.RichText;
  readonly radios?: readonly { readonly value: string; readonly label: Contract.RichText }[];
}

// Annotating a schema with checks annotates its last check, so the last
// annotation written is the one given last.
const propertyAnnotation = (ast: SchemaAST.AST): unknown => {
  for (const check of (ast.checks ?? []).toReversed()) {
    const found = check.annotations?.property;
    if (found !== undefined) return found;
  }
  return ast.annotations?.property;
};

// The property a field's annotation makes of a setting, if it has one.
const boundOf = (
  name: string,
  field: Schema.Top,
  declaration: Contract.SettingDeclaration,
): BoundSetting | undefined => {
  const annotation = propertyAnnotation(field.ast);
  if (annotation === undefined) return undefined;

  const choices = declaration.type === "s" ? declaration.choices : undefined;
  if (declaration.type !== "b" && choices === undefined)
    refuse("has a property annotation, but only a boolean or a literals setting can be a property");
  if (typeof annotation !== "object" || annotation === null || (annotation as SettingProperty).label === undefined)
    refuse("has a property annotation without a label");

  const { label, symbol, values } = annotation as SettingProperty;
  if (!isRichText(label)) refuse(`has a property label ${describe(label)}, which isn't text`);
  if (symbol !== undefined && !isRichText(symbol))
    refuse(`has a property symbol ${describe(symbol)}, which isn't text`);

  const bound = { name, key: gsettingsKey(name), label, ...(symbol === undefined ? {} : { symbol }) };

  if (choices === undefined) {
    if (values !== undefined) refuse("has a property annotation with values, but a boolean setting is a toggle");
    return bound;
  }

  if (typeof values !== "object" || values === null)
    refuse("has a property annotation without a label for each of its values");
  const labelled = Object.keys(values!);
  const missing = choices.filter((choice) => !Object.hasOwn(values!, choice));
  const extra = labelled.filter((value) => !choices.includes(value));
  if (missing.length > 0 || extra.length > 0)
    refuse(
      `has a property annotation whose values don't match its choices: ${
        missing.length > 0 ? `no label for ${describe(missing)}` : `${describe(extra)} isn't a choice`
      }`,
    );

  const unlabelled = choices.find((choice) => !isRichText(values![choice]));
  if (unlabelled !== undefined)
    refuse(`has a property label ${describe(values![unlabelled])} for ${describe(unlabelled)}, which isn't text`);

  return { ...bound, radios: choices.map((value) => ({ value, label: values![value]! })) };
};

/** A settings struct read: the contract's declarations by GSettings key, and each field's schema by name. */
export interface ReadSettings {
  /** The settings that are also properties, in field order. */
  readonly bound: readonly BoundSetting[];
  readonly declarations: Readonly<Record<string, Contract.SettingDeclaration>>;
  readonly fields: Readonly<Record<string, Schema.Top>>;
}

/**
 * Reads a settings struct. Throws a `ModuleDefinitionError` for a struct the kit can't read, a field name that doesn't
 * map to a key, or a field of a shape no setting has, without a default, or with one its schema rejects.
 */
export const readSettings = (settings: unknown): ReadSettings => {
  if (!Schema.isSchema(settings) || !("fields" in settings))
    throw new ModuleDefinitionError({ reason: "the settings aren't a Schema.Struct" });

  const { ast } = settings;
  const fields = settings.fields as Readonly<Record<string, Schema.Top>>;
  if (
    ast._tag !== "Objects" ||
    ast.indexSignatures.length > 0 ||
    ast.checks !== undefined ||
    ast.encoding !== undefined
  )
    throw new ModuleDefinitionError({
      reason: "the settings aren't a Schema.Struct without checks or index signatures",
    });

  const bound: BoundSetting[] = [];
  const declarations = Object.fromEntries(
    ast.propertySignatures.map(({ name }) => {
      const key = String(name);

      if (typeof name !== "string" || !nameMaps(name))
        throw new ModuleDefinitionError({
          key,
          reason:
            "doesn't map to a GSettings key: its name must be a lowercase letter, then letters and digits, at most " +
            `${keyMaxLength} characters once each uppercase letter is written as - and its lowercase`,
        });

      try {
        const declaration = declarationOf(fields[name]!);
        const property = boundOf(name, fields[name]!, declaration);
        if (property !== undefined) bound.push(property);
        return [gsettingsKey(name), declaration];
      } catch (error) {
        if (error instanceof Refused) throw new ModuleDefinitionError({ key, reason: error.message });
        throw error;
      }
    }),
  );
  return { declarations, fields, bound };
};
