// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it } from "@effect/vitest";
import {
  decodeValue,
  encodeValue,
  GVariantDecodeError,
  parseType,
  type GVariantType,
  type GVariantValue,
} from "../../src/index.ts";
import {
  bytesArbitrary,
  largeTypedValueArbitrary,
  mutatedEncodingArbitrary,
  typedValueArbitrary,
  typeArbitrary,
} from "../support/arbitraries.ts";

// Generation and structural comparisons of 64 KiB containers share CPU with the CI host.
// This is a completion watchdog, not the decoder's performance budget.
const largeContainerTimeoutMs = 30_000;

// The one value shape whose accepted encodings are not all canonical: a tuple of variable-size
// members that are all empty, which GLib also accepts in zero bytes.
function isEmptyVariableTuple(type: GVariantType, value: GVariantValue): boolean {
  if (type._tag !== "()" || value._tag !== "()" || type.members.length === 0) return false;
  return type.members.every((member, index) => {
    const item = value.items[index]!;
    if (member.fixedSize !== undefined) return false;
    if (item._tag === "a") return item.items.length === 0;
    if (item._tag === "m") return item.value === null;
    return isEmptyVariableTuple(member, item);
  });
}

function containsEmptyVariableTuple(type: GVariantType, value: GVariantValue): boolean {
  if (isEmptyVariableTuple(type, value)) return true;
  switch (value._tag) {
    case "v":
      return containsEmptyVariableTuple(parseType(value.type), value.value);
    case "m":
      return type._tag === "m" && value.value !== null && containsEmptyVariableTuple(type.element, value.value);
    case "a":
      return type._tag === "a" && value.items.some((item) => containsEmptyVariableTuple(type.element, item));
    case "()":
      return (
        type._tag === "()" && value.items.some((item, index) => containsEmptyVariableTuple(type.members[index]!, item))
      );
    case "{}":
      return type._tag === "{}" && containsEmptyVariableTuple(type.value, value.value);
    default:
      return false;
  }
}

function expectCanonicalOrClean(signature: string, bytes: Uint8Array): void {
  let value;
  try {
    value = decodeValue(signature, bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(GVariantDecodeError);
    return;
  }
  const encoded = encodeValue(signature, value);
  if (!containsEmptyVariableTuple(parseType(signature), value)) expect(encoded).toEqual(bytes);
  expect(decodeValue(signature, encoded)).toEqual(value);
}

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
  "large containers round-trip across offset width boundaries",
  [largeTypedValueArbitrary],
  ([{ signature, value }]) => {
    const bytes = encodeValue(signature, value);
    expect(decodeValue(signature, bytes)).toEqual(value);
  },
  { timeout: largeContainerTimeoutMs, arbitrary: { runs: 200, seed: 3 } },
);
it.prop(
  "arbitrary bytes decode or fail cleanly",
  [typeArbitrary(3), bytesArbitrary(64)],
  ([type, bytes]) => expectCanonicalOrClean(type.signature, bytes),
  { arbitrary: { runs: 2000, seed: 2 } },
);
it.prop(
  "mutated encodings decode or fail cleanly",
  [mutatedEncodingArbitrary],
  ([{ signature, bytes }]) => expectCanonicalOrClean(signature, bytes),
  { timeout: largeContainerTimeoutMs, arbitrary: { runs: 500, seed: 4 } },
);
