// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema, SchemaAST, SchemaTransformation } from "effect";
import { Str } from "./annotations.ts";
import { GVariantVariant } from "../gvariant/schema.ts";

const AttachmentsRecord = Schema.Record(Str, GVariantVariant);
export type Attachments = typeof AttachmentsRecord.Type;

const isKey = Schema.is(Str);
const isVariant = Schema.is(GVariantVariant);

// Effect parses every record through a generator, which dominated decoding a lookup table's
// hundreds of serializables. This guard accepts exactly what the record does, using its schemas.
const Attachments = Schema.declare(
  (input): input is Attachments => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
    for (const key of Object.keys(input)) {
      if (!isKey(key) || !isVariant((input as Record<string, unknown>)[key])) return false;
    }
    return true;
  },
  {
    gvariant: "a{sv}",
    toCodecArbitrary: () => new SchemaAST.Link(AttachmentsRecord.ast, SchemaTransformation.passthrough()),
  },
);

export function serializable<const Fields extends Schema.Struct.Fields>(name: string, fields: Fields) {
  return Schema.Struct({
    attachments: Attachments.annotate({ description: `Named attachments for ${name}.` }),
    ...fields,
  }).annotate({ ibusType: name });
}
