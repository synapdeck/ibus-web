// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";
import { Str } from "./annotations.ts";
import { GVariantVariant } from "../gvariant/schema.ts";

export function serializable<const Fields extends Schema.Struct.Fields>(name: string, fields: Fields) {
  return {
    attachments: Schema.Record(Str, GVariantVariant).annotate({ description: `Named attachments for ${name}.` }),
    ...fields,
  };
}
