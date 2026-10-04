// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Effect, Schema, SchemaAST, SchemaGetter, SchemaIssue, SchemaTransformation } from "effect";
import { isGVariantValue, type GVariantValue } from "./value.ts";
import { decodeValue, GVariantDecodeError } from "./decode.ts";
import { encodeValue } from "./encode.ts";
import { parseType } from "./type.ts";
export const GVariantTree: Schema.declare<GVariantValue> = Schema.declare<GVariantValue>(isGVariantValue, {
  identifier: "GVariantValue",
});
type Variant = Extract<GVariantValue, { _tag: "v" }>;

function scalarVariant<const Tag extends "b" | "i" | "u" | "s" | "x" | "t", S extends Schema.Top>(tag: Tag, value: S) {
  return Schema.Struct({
    _tag: Schema.Literal("v"),
    type: Schema.Literal(tag),
    value: Schema.Struct({ _tag: Schema.Literal(tag), value }),
  });
}

const variantRepresentation: Schema.Codec<Variant> = Schema.Union([
  scalarVariant("b", Schema.Boolean),
  scalarVariant("i", Schema.Number.check(Schema.isInt32())),
  scalarVariant("u", Schema.Number.check(Schema.isUint32())),
  scalarVariant("s", Schema.String.check(Schema.isPattern(/^[^\0\uD800-\uDFFF]*$/u))),
  scalarVariant("x", Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: -(2n ** 63n), maximum: 2n ** 63n - 1n }))),
  scalarVariant("t", Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: 2n ** 64n - 1n }))),
  Schema.Struct({
    _tag: Schema.Literal("v"),
    type: Schema.Literal("av"),
    value: Schema.Struct({
      _tag: Schema.Literal("a"),
      items: Schema.Array(Schema.suspend(() => variantRepresentation)),
    }),
  }),
]);

export const GVariantVariant: Schema.Codec<Extract<GVariantValue, { _tag: "v" }>> = Schema.declare<
  Extract<GVariantValue, { _tag: "v" }>
>((u): u is Extract<GVariantValue, { _tag: "v" }> => isGVariantValue(u) && u._tag === "v", {
  gvariant: "v",
  toCodecArbitrary: () => new SchemaAST.Link(variantRepresentation.ast, SchemaTransformation.passthrough()),
});
const cache = new Map<string, Schema.decodeTo<typeof GVariantTree, typeof Schema.Uint8Array>>();
export const GVariantBytes = (signature: string): Schema.decodeTo<typeof GVariantTree, typeof Schema.Uint8Array> => {
  const cached = cache.get(signature);
  if (cached) return cached;
  parseType(signature);
  const schema = Schema.Uint8Array.pipe(
    Schema.decodeTo(GVariantTree, {
      decode: SchemaGetter.transformEffect((bytes, options) =>
        Effect.try({
          try: () => decodeValue(signature, bytes),
          catch: (error) =>
            new SchemaIssue.InvalidValue(
              {
                message: `GVariant ${signature}: ${error instanceof GVariantDecodeError ? error.message : String(error)}`,
              },
              bytes,
              options,
            ),
        }),
      ),
      encode: SchemaGetter.transform((value) => encodeValue(signature, value)),
    }),
  );
  cache.set(signature, schema);
  return schema;
};
