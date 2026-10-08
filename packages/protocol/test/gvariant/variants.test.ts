// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import { encodeValue } from "../../src/gvariant/encode.ts";
import { isGVariantValue } from "../../src/gvariant/value.ts";
import { booleanVariant, int32Variant, stringVariant, variant } from "../../src/gvariant/variants.ts";

test("variant boxes a value with its type", () => {
  expect(variant("u", { _tag: "u", value: 7 })).toEqual({ _tag: "v", type: "u", value: { _tag: "u", value: 7 } });
});

test("the scalar constructors box their value with its signature", () => {
  expect(stringVariant("한")).toEqual({ _tag: "v", type: "s", value: { _tag: "s", value: "한" } });
  expect(booleanVariant(true)).toEqual({ _tag: "v", type: "b", value: { _tag: "b", value: true } });
  expect(int32Variant(-3)).toEqual({ _tag: "v", type: "i", value: { _tag: "i", value: -3 } });
});

test("what they build is a value the codec encodes", () => {
  for (const value of [stringVariant("x"), booleanVariant(false), int32Variant(4)]) {
    expect(isGVariantValue(value)).toBe(true);
    expect(encodeValue("v", value).byteLength).toBeGreaterThan(0);
  }
});
