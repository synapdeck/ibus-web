// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it } from "@effect/vitest";
import { decodeValue, encodeValue, GVariantDecodeError } from "../../src/index.ts";
import { typedValueArbitrary, typeArbitrary, bytesArbitrary } from "../support/arbitraries.ts";
it.prop(
  "values round-trip",
  [typedValueArbitrary],
  ([{ signature, value }]) => {
    const bytes = encodeValue(signature, value);
    const decoded = decodeValue(signature, bytes);
    expect(decoded).toEqual(value);
    expect(encodeValue(signature, decoded)).toEqual(bytes);
  },
  { arbitrary: { runs: 2000, seed: 1 } },
);
it.prop(
  "arbitrary bytes decode or fail cleanly",
  [typeArbitrary(3), bytesArbitrary(64)],
  ([type, bytes]) => {
    let value;
    try {
      value = decodeValue(type.signature, bytes);
    } catch (error) {
      expect(error).toBeInstanceOf(GVariantDecodeError);
      return;
    }
    expect(encodeValue(type.signature, value)).toEqual(bytes);
  },
  { arbitrary: { runs: 2000, seed: 2 } },
);
