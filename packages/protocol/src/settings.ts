// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema, SchemaGetter } from "effect";
import { encodeValue } from "./gvariant/encode.ts";
import type { GVariantValue } from "./gvariant/value.ts";
import { nonEmpty } from "./strings.ts";

// Structural schemas let Effect derive lossless JSON encodings, including decimal
// strings for 64-bit integers, without changing the protocol's in-memory tree.
const double = Schema.Union([Schema.Number, Schema.Literal("-0")]).pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((value) => (value === "-0" ? -0 : value)),
    encode: SchemaGetter.transform((value) => (Object.is(value, -0) ? ("-0" as const) : value)),
  }),
);
const value: Schema.Codec<GVariantValue, unknown> = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("b"), value: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literals(["y", "n", "q", "i", "u", "h"]), value: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal("d"), value: double }),
  Schema.Struct({ _tag: Schema.Literals(["x", "t"]), value: Schema.BigInt }),
  Schema.Struct({ _tag: Schema.Literals(["s", "o", "g"]), value: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("v"), type: Schema.String, value: Schema.suspend(() => value) }),
  Schema.Struct({ _tag: Schema.Literal("m"), value: Schema.NullOr(Schema.suspend(() => value)) }),
  Schema.Struct({ _tag: Schema.Literals(["a", "()"]), items: Schema.Array(Schema.suspend(() => value)) }),
  Schema.Struct({ _tag: Schema.Literal("{}"), key: Schema.suspend(() => value), value: Schema.suspend(() => value) }),
]);
const key = Schema.Struct({
  name: nonEmpty,
  type: nonEmpty,
  default: value,
  summary: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  range: Schema.optionalKey(Schema.Struct({ min: value, max: value })),
  choices: Schema.optionalKey(Schema.Array(Schema.String)),
}).check(
  Schema.makeFilter((key) => {
    try {
      encodeValue(key.type, key.default);
      if (key.range) {
        encodeValue(key.type, key.range.min);
        encodeValue(key.type, key.range.max);
      }
      return true;
    } catch {
      return "settings values must match their GVariant type";
    }
  }),
);

const path = Schema.String.check(
  Schema.isPattern(/^\/(?:[^/\0]+\/)*$/),
  Schema.makeFilter(
    (path) => !path.split("/").some((part) => part === "." || part === "..") || "schema path must be canonical",
  ),
);

// {name} stands for one or more characters of a component, never a /.
const pattern = Schema.String.check(
  Schema.isPattern(/^\/(?:(?:[^/\0{}]|\{[A-Za-z0-9_-]+\})+\/)*$/),
  Schema.makeFilter((pattern) => pattern.includes("{") || "a settings pattern has a {placeholder}"),
);

/** Whether path is one of the paths pattern stands for. */
export const settingsPatternMatches = (pattern: string, path: string): boolean =>
  new RegExp(
    `^${pattern
      .split(/(\{[A-Za-z0-9_-]+\})/)
      .map((part, i) => (i % 2 === 1 ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("")}$`,
    "u",
  ).test(path);

export const SettingsMetadata = Schema.toCodecJson(
  Schema.Struct({
    schemas: Schema.Array(
      Schema.Struct({
        id: nonEmpty,
        // A fixed schema lives at its one path; a relocatable one at each path the build declares.
        paths: Schema.Array(path).check(Schema.isNonEmpty()),
        // A relocatable schema's paths, as one pattern, which Init declares in their place.
        pattern: Schema.optionalKey(pattern),
        keys: Schema.Array(key).check(
          Schema.makeFilter(
            (keys) => new Set(keys.map((key) => key.name)).size === keys.length || "duplicate settings keys",
          ),
        ),
      }).check(
        Schema.makeFilter(
          (schema) =>
            schema.pattern === undefined ||
            schema.paths.every((path) => settingsPatternMatches(schema.pattern!, path)) ||
            `a path of ${schema.id} doesn't match its pattern`,
        ),
      ),
    ).check(
      Schema.makeFilter(
        (schemas) => new Set(schemas.map((schema) => schema.id)).size === schemas.length || "duplicate schema ids",
      ),
      Schema.makeFilter((schemas) => {
        const paths = schemas.flatMap((schema) => schema.paths);
        return new Set(paths).size === paths.length || "duplicate settings paths";
      }),
    ),
  }),
);
export type SettingsMetadata = typeof SettingsMetadata.Type;
export type SettingsMetadataJson = typeof SettingsMetadata.Encoded;
export const decodeSettingsMetadata = Schema.decodeUnknownSync(SettingsMetadata, { onExcessProperty: "error" });
export const encodeSettingsMetadata = Schema.encodeSync(SettingsMetadata);
