// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, it } from "vitest";
import { decodeValue, encodeValue, GVariantDecodeError, type GVariantValue } from "../../src/index.ts";
it.each<[string, string, number]>([
  ["b", "02", 0],
  ["s", "61", 0],
  ["s", "61006200", 1],
  ["s", "ff00", 0],
  ["s", "6162ff00", 2],
  ["(ys)", "016162ff00", 3],
  ["s", "eab080ff00", 3],
  ["s", "61e28200", 1],
  ["(yu)", "0101000005000000", 1],
  ["u", "000000", 0],
  ["as", "61000200", 0],
  ["as", "61006200020104", 5],
  ["v", "00007575", 2],
  ["o", "612f2f6200", 0],
  ["g", "287500", 0],
  ["mi", "000000", 0],
])("rejects malformed %s bytes at the fault", (sig, hex, offset) => {
  try {
    decodeValue(sig, Uint8Array.from(Buffer.from(hex, "hex")));
    expect.fail("accepted malformed bytes");
  } catch (error) {
    expect(error).toBeInstanceOf(GVariantDecodeError);
    expect(error).toMatchObject({ offset });
  }
});
it("rejects variants nested past 128", () => {
  const bytes = Uint8Array.from([1, ...Array.from({ length: 129 }, (_, i) => [0, i === 0 ? 121 : 118]).flat()]);
  expect(() => decodeValue("v", bytes)).toThrow(GVariantDecodeError);
});

it("rejects an offset table that inflates its own width", () => {
  const bytes = new Uint8Array(256);
  bytes.fill(97, 0, 253);
  bytes[254] = 254;
  expect(() => decodeValue("as", bytes)).toThrow(GVariantDecodeError);
});

it("preserves a UTF-8 byte order mark in a string", () => {
  expect(decodeValue("s", Uint8Array.of(239, 187, 191, 0))).toEqual({ _tag: "s", value: "\ufeff" });
});

it("validates signature sequences with GLib's signature grammar", () => {
  const bytes = (value: string) => new TextEncoder().encode(value + "\0");
  for (const value of ["", "uu", "{sv}", "a".repeat(128) + "y"]) {
    expect(decodeValue("g", bytes(value))).toEqual({ _tag: "g", value });
  }
  for (const value of ["mi", "m", "a".repeat(129) + "y"]) {
    expect(() => decodeValue("g", bytes(value))).toThrow(GVariantDecodeError);
  }
});

it("resets UTF-8 decoding after locating a malformed sequence", () => {
  expect(() => decodeValue("s", Uint8Array.of(97, 226, 130, 0))).toThrow(GVariantDecodeError);
  expect(decodeValue("s", Uint8Array.of(98, 0))).toEqual({ _tag: "s", value: "b" });
});

describe("GLib's recursion limit", () => {
  const nestedArrays = (levels: number) => Uint8Array.from([5, ...Array.from({ length: levels - 1 }, (_, i) => i + 1)]);
  const nestedVariants = (levels: number) =>
    Uint8Array.from([1, 0, 121, ...Array.from({ length: levels - 1 }, () => [0, 118]).flat()]);
  const variantOfEmptyArray = (levels: number) => new TextEncoder().encode(`\0${"a".repeat(levels)}y`);

  it("rejects a value 128 containers deep", () => {
    expect(decodeValue("a".repeat(127) + "y", nestedArrays(127))).toMatchObject({ _tag: "a" });
    expect(() => decodeValue("a".repeat(128) + "y", nestedArrays(128))).toThrow(GVariantDecodeError);
  });

  it("rejects 128 nested variants", () => {
    expect(decodeValue("v", nestedVariants(127))).toMatchObject({ _tag: "v" });
    expect(() => decodeValue("v", nestedVariants(128))).toThrow(GVariantDecodeError);
  });

  it("counts the depth of a variant's type, not only of its value", () => {
    expect(decodeValue("v", variantOfEmptyArray(126))).toMatchObject({ _tag: "v", value: { _tag: "a", items: [] } });
    expect(() => decodeValue("v", variantOfEmptyArray(127))).toThrow(GVariantDecodeError);
  });

  it("accepts an empty tuple at the type nesting limit", () => {
    expect(decodeValue("a".repeat(128) + "()", new Uint8Array())).toEqual({ _tag: "a", items: [] });
    const signature = new TextEncoder().encode("a".repeat(128) + "()\0");
    expect(decodeValue("g", signature)).toEqual({ _tag: "g", value: "a".repeat(128) + "()" });
  });
});

describe("zero-byte tuples of variable-size members", () => {
  const empty: GVariantValue = { _tag: "a", items: [] };
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

  // GLib's normal-form check reads every framing offset of a zero-byte tuple as 0, so it accepts
  // these, although its own serializer writes the same values with explicit offsets. Accepting
  // them keeps the decoder's notion of normal form identical to GLib's, at the cost of these
  // inputs re-encoding to longer bytes.
  it.each<[string, string, GVariantValue, string]>([
    ["(ayay)", "", { _tag: "()", items: [empty, empty] }, "00"],
    ["m(ayay)", "00", { _tag: "m", value: { _tag: "()", items: [empty, empty] } }, "0000"],
    ["(asmay)", "", { _tag: "()", items: [empty, { _tag: "m", value: null }] }, "00"],
    ["((ayay)ay)", "00", { _tag: "()", items: [{ _tag: "()", items: [empty, empty] }, empty] }, "0001"],
    ["a(ayay)", "00", { _tag: "a", items: [{ _tag: "()", items: [empty, empty] }] }, "0001"],
    [
      "v",
      "00286179617929",
      { _tag: "v", type: "(ayay)", value: { _tag: "()", items: [empty, empty] } },
      "0000286179617929",
    ],
  ])("accepts %s %s and re-encodes it with explicit offsets", (signature, input, value, canonical) => {
    const decoded = decodeValue(signature, Uint8Array.from(Buffer.from(input, "hex")));
    expect(decoded).toEqual(value);
    expect(hex(encodeValue(signature, decoded))).toBe(canonical);
  });

  it.each(["(ays)", "(ayv)", "(yay)", "{say}"])("rejects zero-byte %s", (signature) => {
    expect(() => decodeValue(signature, new Uint8Array())).toThrow(GVariantDecodeError);
  });
});
