// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Arbitrary, Schema } from "effect";
import { encodeValue, parseType, type GVariantType, type GVariantValue } from "../../src/index.ts";
import { isWellFormedString } from "../../src/gvariant/value.ts";

// flatMap callbacks run again on every shrink and replay, so every Arbitrary a callback returns
// is built once, ahead of time, and only selected there.

const basicCharacters = ["b", "y", "n", "q", "i", "u", "h", "x", "t", "d", "s", "o", "g"] as const;
const leafConstructors = [...basicCharacters, "v"] as const;
const allConstructors = [...leafConstructors, "a", "m", "()", "{}"] as const;

function integers(minimum: number, maximum: number): Arbitrary.Arbitrary<number> {
  return Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));
}

function oneOf<A>(arbitraries: readonly Arbitrary.Arbitrary<A>[]): Arbitrary.Arbitrary<A> {
  return Arbitrary.flatMap(integers(0, arbitraries.length - 1), (index) => arbitraries[index]!);
}

function withBounds<A>(arbitrary: Arbitrary.Arbitrary<A>, bounds: readonly A[]): Arbitrary.Arbitrary<A> {
  const bound = Arbitrary.map(integers(0, bounds.length - 1), (index) => bounds[index]!);
  return oneOf([arbitrary, bound]);
}

const booleans = Arbitrary.schema(Schema.Boolean);
const typeArbitraries = new Map<number, Arbitrary.Arbitrary<GVariantType>>();

export function typeArbitrary(depth: number): Arbitrary.Arbitrary<GVariantType> {
  const cached = typeArbitraries.get(depth);
  if (cached !== undefined) return cached;
  const leaves = Arbitrary.map(Arbitrary.schema(Schema.Literals(leafConstructors)), parseType);
  let arbitrary = leaves;
  if (depth > 0) {
    const inner = typeArbitrary(depth - 1);
    const containers = {
      a: Arbitrary.map(inner, (element) => parseType(`a${element.signature}`)),
      m: Arbitrary.map(inner, (element) => parseType(`m${element.signature}`)),
      "()": Arbitrary.map(Arbitrary.array(inner, { maxLength: 4 }), (members) =>
        parseType(`(${members.map((member) => member.signature).join("")})`),
      ),
      "{}": Arbitrary.map(Arbitrary.all([Arbitrary.schema(Schema.Literals(basicCharacters)), inner]), ([key, value]) =>
        parseType(`{${key}${value.signature}}`),
      ),
    };
    arbitrary = Arbitrary.flatMap(Arbitrary.schema(Schema.Literals(allConstructors)), (tag) =>
      tag === "a" || tag === "m" || tag === "()" || tag === "{}" ? containers[tag] : leaves,
    );
  }
  typeArbitraries.set(depth, arbitrary);
  return arbitrary;
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
  return Arbitrary.map(withBounds(integers(minimum, maximum), [minimum, maximum]), (value) => ({ _tag: tag, value }));
}

function bigintArbitrary(tag: "x" | "t"): Arbitrary.Arbitrary<GVariantValue> {
  const minimum = tag === "x" ? -(2n ** 63n) : 0n;
  const maximum = tag === "x" ? 2n ** 63n - 1n : 2n ** 64n - 1n;
  const values = Arbitrary.schema(Schema.BigInt.check(Schema.isBetweenBigInt({ minimum, maximum })));
  return Arbitrary.map(withBounds(values, [minimum, maximum]), (value) => ({ _tag: tag, value }));
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
      strings = Arbitrary.schema(Schema.Literals(["/", "/a_b/ABC123"]));
      break;
    case "g":
      strings = Arbitrary.schema(Schema.Literals(["", "u", "a{sv}", "(si)", "uu", "{sv}", "a".repeat(128) + "()"]));
      break;
  }
  return Arbitrary.map(strings, (value) => ({ _tag: tag, value }));
}

const basicValueArbitraries: Readonly<Record<(typeof basicCharacters)[number], Arbitrary.Arbitrary<GVariantValue>>> = {
  b: Arbitrary.map(booleans, (value) => ({ _tag: "b", value })),
  d: Arbitrary.map(Arbitrary.schema(Schema.Number.check(Schema.isFinite())), (value) => ({ _tag: "d", value })),
  x: bigintArbitrary("x"),
  t: bigintArbitrary("t"),
  s: stringArbitrary("s"),
  o: stringArbitrary("o"),
  g: stringArbitrary("g"),
  y: integerArbitrary("y"),
  n: integerArbitrary("n"),
  q: integerArbitrary("q"),
  i: integerArbitrary("i"),
  u: integerArbitrary("u"),
  h: integerArbitrary("h"),
};

const valueArbitraries = new WeakMap<GVariantType, Arbitrary.Arbitrary<GVariantValue>>();
const nothing = Arbitrary.Constant<GVariantValue>({ _tag: "m", value: null });

// parseType memoizes, so a type's identity is a sound cache key; caching also keeps the variant
// case's callback from building a fresh Arbitrary per draw.
export function valueArbitrary(type: GVariantType): Arbitrary.Arbitrary<GVariantValue> {
  const cached = valueArbitraries.get(type);
  if (cached !== undefined) return cached;
  let arbitrary: Arbitrary.Arbitrary<GVariantValue>;
  switch (type._tag) {
    case "basic":
      arbitrary = basicValueArbitraries[type.char];
      break;
    case "v":
      arbitrary = Arbitrary.flatMap(typeArbitrary(1), (childType) =>
        Arbitrary.map(valueArbitrary(childType), (value): GVariantValue => ({
          _tag: "v",
          type: childType.signature,
          value,
        })),
      );
      break;
    case "m": {
      const just = Arbitrary.map(valueArbitrary(type.element), (value): GVariantValue => ({ _tag: "m", value }));
      arbitrary = oneOf([nothing, just]);
      break;
    }
    case "a":
      arbitrary = Arbitrary.map(
        Arbitrary.array(valueArbitrary(type.element), { maxLength: 4 }),
        (items): GVariantValue => ({ _tag: "a", items }),
      );
      break;
    case "()":
      arbitrary = Arbitrary.map(Arbitrary.all(type.members.map(valueArbitrary)), (items): GVariantValue => ({
        _tag: "()",
        items,
      }));
      break;
    case "{}":
      arbitrary = Arbitrary.map(
        Arbitrary.all([valueArbitrary(type.key), valueArbitrary(type.value)]),
        ([key, value]): GVariantValue => ({ _tag: "{}", key, value }),
      );
      break;
  }
  valueArbitraries.set(type, arbitrary);
  return arbitrary;
}

export interface TypedValue {
  readonly signature: string;
  readonly value: GVariantValue;
}

export const typedValueArbitrary: Arbitrary.Arbitrary<TypedValue> = Arbitrary.flatMap(typeArbitrary(3), (type) =>
  Arbitrary.map(valueArbitrary(type), (value) => ({ signature: type.signature, value })),
);

const largeShapes = ["as", "(sy)", "aay", "v"] as const;

/**
 * Builds a container whose data is `body` bytes spread over `count` variable-size children, so
 * the framing offsets alone can push it past an offset width boundary.
 */
function largeContainer(shape: (typeof largeShapes)[number], body: number, count: number): TypedValue {
  const strings = (total: number): GVariantValue[] => [
    { _tag: "s", value: "a".repeat(total - count) },
    ...Array.from({ length: count - 1 }, (): GVariantValue => ({ _tag: "s", value: "" })),
  ];
  switch (shape) {
    case "as":
      return { signature: "as", value: { _tag: "a", items: strings(body) } };
    case "(sy)":
      return {
        signature: `(${"s".repeat(count)}y)`,
        value: { _tag: "()", items: [...strings(body - 1), { _tag: "y", value: 7 }] },
      };
    case "aay": {
      const bytes = (length: number): GVariantValue => ({
        _tag: "a",
        items: Array.from({ length }, (_, index): GVariantValue => ({ _tag: "y", value: index & 0xff })),
      });
      return {
        signature: "aay",
        value: { _tag: "a", items: [bytes(body), ...Array.from({ length: count - 1 }, () => bytes(0))] },
      };
    }
    case "v":
      return { signature: "v", value: { _tag: "v", type: "as", value: { _tag: "a", items: strings(body) } } };
  }
}

/**
 * Containers sized around the 255 and 65535 byte boundaries where framing offsets widen from one
 * byte to two and from two to four, including bodies that only cross once their offsets are
 * added.
 */
export const largeTypedValueArbitrary: Arbitrary.Arbitrary<TypedValue> = Arbitrary.map(
  Arbitrary.all([
    Arbitrary.schema(Schema.Literals(largeShapes)),
    Arbitrary.schema(Schema.Literals([255, 65535])),
    integers(-24, 8),
    integers(1, 12),
  ]),
  ([shape, boundary, delta, count]) => largeContainer(shape, boundary + delta, count),
);

export function bytesArbitrary(maxLength: number): Arbitrary.Arbitrary<Uint8Array> {
  return Arbitrary.map(Arbitrary.array(integers(0, 255), { maxLength }), (bytes) => Uint8Array.from(bytes));
}

const mutationKinds = ["replace", "flip", "truncate", "extend"] as const;
const mutation = Arbitrary.all([
  Arbitrary.schema(Schema.Literals(mutationKinds)),
  integers(0, 2 ** 31 - 1),
  integers(0, 255),
]);

function mutate(bytes: Uint8Array, [kind, where, byte]: readonly [(typeof mutationKinds)[number], number, number]) {
  switch (kind) {
    case "replace":
    case "flip": {
      if (bytes.length === 0) return Uint8Array.of(byte);
      const copy = Uint8Array.from(bytes);
      const position = where % bytes.length;
      copy[position] = kind === "replace" ? byte : copy[position]! ^ (1 << (byte & 7));
      return copy;
    }
    case "truncate":
      return bytes.subarray(0, where % (bytes.length + 1));
    case "extend": {
      const copy = new Uint8Array(bytes.length + 1);
      copy.set(bytes);
      copy[bytes.length] = byte;
      return copy;
    }
  }
}

/**
 * The normal-form encoding of a random typed value, including large containers, with one to
 * three single-byte replacements, bit flips, truncations or extensions applied.
 */
export const mutatedEncodingArbitrary: Arbitrary.Arbitrary<{ signature: string; bytes: Uint8Array }> = Arbitrary.map(
  Arbitrary.all([
    oneOf([typedValueArbitrary, typedValueArbitrary, typedValueArbitrary, largeTypedValueArbitrary]),
    Arbitrary.array(mutation, { minLength: 1, maxLength: 3 }),
  ]),
  ([{ signature, value }, mutations]) => ({
    signature,
    bytes: mutations.reduce(mutate, encodeValue(signature, value)),
  }),
);
