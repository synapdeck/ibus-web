// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "@effect/vitest";
import { Schema } from "effect";
import { GVariantBytes, GVariantTree, GVariantVariant } from "../../src/index.ts";
test("decodes and encodes a typed byte schema", () => {
  const codec = GVariantBytes("(si)");
  const bytes = Uint8Array.from([102, 111, 111, 0, 255, 255, 255, 255, 4]);
  const value = {
    _tag: "()",
    items: [
      { _tag: "s", value: "foo" },
      { _tag: "i", value: -1 },
    ],
  } as const;
  expect(Schema.decodeUnknownSync(codec)(bytes)).toEqual(value);
  expect(Schema.encodeSync(codec)(value)).toEqual(bytes);
  expect(GVariantBytes("(si)")).toBe(codec);
});
test("reports decode failures with the signature and codec error", () => {
  try {
    Schema.decodeUnknownSync(GVariantBytes("b"))(Uint8Array.of(2));
    expect.fail();
  } catch (error) {
    expect(Schema.isSchemaError(error)).toBe(true);
    expect(String(error)).toMatch(/GVariant b:.*boolean/);
  }
  expect(() => Schema.decodeUnknownSync(GVariantBytes("s"))("abc")).toThrow(/Expected Uint8Array/);
});
test("validates recursive trees and variant nodes", () => {
  expect(Schema.is(GVariantTree)({ _tag: "a", items: [{ _tag: "u", value: 1 }] })).toBe(true);
  expect(Schema.is(GVariantTree)({ _tag: "a", items: [{ _tag: "b", value: 1 }] })).toBe(false);
  expect(Schema.is(GVariantVariant)({ _tag: "v", type: "u", value: { _tag: "u", value: 1 } })).toBe(true);
  expect(Schema.is(GVariantVariant)({ _tag: "u", value: 1 })).toBe(false);
});
