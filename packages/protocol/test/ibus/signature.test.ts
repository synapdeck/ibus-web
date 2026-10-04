// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { GVariantVariant, ProtocolError } from "../../src/index.ts";
import { signatureOf } from "../../src/ibus/walk.ts";
import {
  IBusAttribute,
  IBusAttrList,
  IBusText,
  IBusLookupTable,
  IBusProperty,
  IBusPropList,
} from "../../src/ibus/types.ts";

it.each([
  [IBusAttribute, "(sa{sv}uuuu)"],
  [IBusAttrList, "(sa{sv}av)"],
  [IBusText, "(sa{sv}sv)"],
  [IBusLookupTable, "(sa{sv}uubbiavav)"],
  [IBusProperty, "(sa{sv}suvsvbbuvv)"],
  [IBusPropList, "(sa{sv}av)"],
] as const)("derives %s signature", (schema, signature) => {
  expect(signatureOf(schema)).toBe(signature);
});
it("wraps serializable members in variants", () => {
  expect(signatureOf(Schema.Struct({ text: IBusText }))).toBe("(v)");
  expect(signatureOf(Schema.Array(IBusText))).toBe("av");
});
it("derives nested dictionaries", () => {
  const attachments = Schema.Record(Schema.String, GVariantVariant);
  expect(signatureOf(attachments)).toBe("a{sv}");
  expect(signatureOf(Schema.Record(Schema.String, attachments))).toBe("a{sa{sv}}");
});
it("names an unannotated field", () => {
  const schema = Schema.Struct({ missingType: Schema.Number });
  expect(() => signatureOf(schema)).toThrow(ProtocolError);
  expect(() => signatureOf(schema)).toThrow(/missingType/);
});
