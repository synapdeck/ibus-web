// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Arbitrary, Schema } from "effect";
import { parseType, type GVariantType, type GVariantValue } from "../../src/index.ts";
import { isWellFormedString } from "../../src/gvariant/value.ts";

const basicCharacters = ["b", "y", "n", "q", "i", "u", "h", "x", "t", "d", "s", "o", "g"] as const;
const leafConstructors = [...basicCharacters, "v"] as const;
const allConstructors = [...leafConstructors, "a", "m", "()", "{}"] as const;

function choose<A>(values: readonly A[]): Arbitrary.Arbitrary<A> {
  const index = Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: values.length - 1 })));
  return Arbitrary.flatMap(index, (i) => Arbitrary.Constant(values[i]!));
}

function withBounds<A>(arbitrary: Arbitrary.Arbitrary<A>, bounds: readonly A[]): Arbitrary.Arbitrary<A> {
  return Arbitrary.flatMap(Arbitrary.schema(Schema.Boolean), (useBound) => (useBound ? choose(bounds) : arbitrary));
}

export function typeArbitrary(depth: number): Arbitrary.Arbitrary<GVariantType> {
  const constructor = Arbitrary.schema(Schema.Literals(depth === 0 ? leafConstructors : allConstructors));
  return Arbitrary.flatMap(constructor, (tag) => {
    switch (tag) {
      case "a":
      case "m":
        return Arbitrary.map(typeArbitrary(depth - 1), (element) => parseType(tag + element.signature));
      case "()": {
        const members = Arbitrary.array(typeArbitrary(depth - 1), { maxLength: 4 });
        return Arbitrary.map(members, (types) => parseType(`(${types.map((type) => type.signature).join("")})`));
      }
      case "{}": {
        const members = Arbitrary.all([choose(basicCharacters), typeArbitrary(depth - 1)]);
        return Arbitrary.map(members, ([key, value]) => parseType(`{${key}${value.signature}}`));
      }
      default:
        return Arbitrary.Constant(parseType(tag));
    }
  });
}

const integerRanges = {
  y: [0, 255],
  n: [-32768, 32767],
  q: [0, 65535],
  i: [-2147483648, 2147483647],
  u: [0, 4294967295],
  h: [-2147483648, 2147483647],
} as const;

function integerArbitrary(tag: keyof typeof integerRanges): Arbitrary.Arbitrary<GVariantValue> {
  const [minimum, maximum] = integerRanges[tag];
  const integers = Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));
  return Arbitrary.map(withBounds(integers, [minimum, maximum]), (value) => ({ _tag: tag, value }));
}

function bigintArbitrary(tag: "x" | "t"): Arbitrary.Arbitrary<GVariantValue> {
  const minimum = tag === "x" ? -(2n ** 63n) : 0n;
  const maximum = tag === "x" ? 2n ** 63n - 1n : 2n ** 64n - 1n;
  const integers = Arbitrary.schema(Schema.BigInt.check(Schema.isBetweenBigInt({ minimum, maximum })));
  return Arbitrary.map(withBounds(integers, [minimum, maximum]), (value) => ({ _tag: tag, value }));
}

function stringArbitrary(tag: "s" | "o" | "g"): Arbitrary.Arbitrary<GVariantValue> {
  let strings: Arbitrary.Arbitrary<string>;
  switch (tag) {
    case "s": {
      const validStrings = Arbitrary.filter(
        Arbitrary.schema(Schema.String),
        (value) => !value.includes("\0") && isWellFormedString(value),
      );
      strings = withBounds(validStrings, ["", "한글", "😀", "a".repeat(300)]);
      break;
    }
    case "o":
      strings = choose(["/", "/a_b/ABC123"]);
      break;
    case "g":
      strings = choose(["", "u", "a{sv}", "(si)", "uu"]);
      break;
  }
  return Arbitrary.map(strings, (value) => ({ _tag: tag, value }));
}

function basicValueArbitrary(type: GVariantType & { _tag: "basic" }): Arbitrary.Arbitrary<GVariantValue> {
  const tag = type.char;
  switch (tag) {
    case "b":
      return Arbitrary.map(Arbitrary.schema(Schema.Boolean), (value) => ({ _tag: tag, value }));
    case "d":
      return Arbitrary.map(Arbitrary.schema(Schema.Number.check(Schema.isFinite())), (value) => ({ _tag: tag, value }));
    case "x":
    case "t":
      return bigintArbitrary(tag);
    case "s":
    case "o":
    case "g":
      return stringArbitrary(tag);
    default:
      return integerArbitrary(tag);
  }
}

export function valueArbitrary(type: GVariantType): Arbitrary.Arbitrary<GVariantValue> {
  switch (type._tag) {
    case "basic":
      return basicValueArbitrary(type);
    case "v":
      return Arbitrary.flatMap(typeArbitrary(1), (childType) =>
        Arbitrary.map(valueArbitrary(childType), (value) => ({ _tag: "v", type: childType.signature, value })),
      );
    case "m":
      return Arbitrary.flatMap(Arbitrary.schema(Schema.Boolean), (present) => {
        if (!present) return Arbitrary.Constant<GVariantValue>({ _tag: "m", value: null });
        return Arbitrary.map(valueArbitrary(type.element), (value): GVariantValue => ({ _tag: "m", value }));
      });
    case "a":
      return Arbitrary.map(Arbitrary.array(valueArbitrary(type.element), { maxLength: 4 }), (items) => ({
        _tag: "a",
        items,
      }));
    case "()":
      return Arbitrary.map(Arbitrary.all(type.members.map(valueArbitrary)), (items) => ({ _tag: "()", items }));
    case "{}":
      return Arbitrary.map(Arbitrary.all([valueArbitrary(type.key), valueArbitrary(type.value)]), ([key, value]) => ({
        _tag: "{}",
        key,
        value,
      }));
  }
}

export const typedValueArbitrary: Arbitrary.Arbitrary<{ signature: string; value: GVariantValue }> = Arbitrary.flatMap(
  typeArbitrary(3),
  (type) => Arbitrary.map(valueArbitrary(type), (value) => ({ signature: type.signature, value })),
);

export function bytesArbitrary(maxLength: number): Arbitrary.Arbitrary<Uint8Array> {
  const byte = Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })));
  return Arbitrary.map(Arbitrary.array(byte, { maxLength }), (bytes) => Uint8Array.from(bytes));
}
