// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect";
import { isGVariantValue, type GVariantValue } from "./value.ts";
import { decodeValue, GVariantDecodeError } from "./decode.ts";
import { encodeValue } from "./encode.ts";
import { parseType } from "./type.ts";
export const GVariantTree: Schema.declare<GVariantValue> = Schema.declare<GVariantValue>(isGVariantValue, {
  identifier: "GVariantValue",
});
export const GVariantVariant: Schema.Codec<Extract<GVariantValue, { _tag: "v" }>> = Schema.declare<
  Extract<GVariantValue, { _tag: "v" }>
>((u): u is Extract<GVariantValue, { _tag: "v" }> => isGVariantValue(u) && u._tag === "v", { gvariant: "v" });
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
