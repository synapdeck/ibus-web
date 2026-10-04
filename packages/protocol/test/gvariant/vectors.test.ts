// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it } from "vitest";
import { encodeValue, decodeValue, GVariantDecodeError, type GVariantValue } from "../../src/index.ts";
const s = (value: string): GVariantValue => ({ _tag: "s", value });
const vectors: [string, GVariantValue, string][] = [
  ["s", s("hello world"), "68656c6c6f20776f726c6400"],
  ["ms", { _tag: "m", value: s("hello world") }, "68656c6c6f20776f726c640000"],
  ["mi", { _tag: "m", value: null }, ""],
  ["mi", { _tag: "m", value: { _tag: "i", value: 5 } }, "05000000"],
  ["ab", { _tag: "a", items: [true, false, true, true].map((value) => ({ _tag: "b", value })) }, "01000101"],
  ["(si)", { _tag: "()", items: [s("foo"), { _tag: "i", value: -1 }] }, "666f6f00ffffffff04"],
  [
    "as",
    { _tag: "a", items: ["i", "can", "has", "strings?"].map(s) },
    "690063616e0068617300737472696e67733f0002060a13",
  ],
  ["()", { _tag: "()", items: [] }, "00"],
  ["v", { _tag: "v", type: "u", value: { _tag: "u", value: 5 } }, "050000000075"],
  ["a{sv}", { _tag: "a", items: [] }, ""],
  [
    "(ua{sa{sv}})",
    {
      _tag: "()",
      items: [
        { _tag: "u", value: 1 },
        { _tag: "a", items: [] },
      ],
    },
    "0100000000000000",
  ],
  ["t", { _tag: "t", value: 2n ** 64n - 1n }, "ffffffffffffffff"],
];
it.each(vectors)("matches the %s reference vector", (signature, value, hex) => {
  const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
  expect(encodeValue(signature, value)).toEqual(bytes);
  expect(decodeValue(signature, bytes)).toEqual(value);
});
it("uses two-byte offsets when the array exceeds 255 bytes", () => {
  const value: GVariantValue = { _tag: "a", items: Array.from({ length: 100 }, () => s("abcd")) };
  const bytes = encodeValue("as", value);
  expect(bytes.length).toBe(700);
  expect(Array.from(bytes.slice(-2))).toEqual([244, 1]);
  expect(decodeValue("as", bytes)).toEqual(value);
});

// One long string followed by empty ones: `body` bytes of data framed by `count` offsets.
const strings = (body: number, count: number): GVariantValue => ({
  _tag: "a",
  items: [s("a".repeat(body - count)), ...Array.from({ length: count - 1 }, () => s(""))],
});
it.each<[number, number, number, number]>([
  [253, 2, 1, 255],
  [254, 2, 2, 258],
  [256, 1, 2, 258],
  [65533, 1, 2, 65535],
  [65534, 1, 4, 65538],
  [65520, 9, 4, 65556],
])("frames a %i-byte body with %i offsets at width %i", (body, count, width, total) => {
  const value = strings(body, count);
  const bytes = encodeValue("as", value);
  expect(bytes.length).toBe(total);
  const view = new DataView(bytes.buffer);
  const last =
    width === 1
      ? view.getUint8(total - 1)
      : width === 2
        ? view.getUint16(total - 2, true)
        : view.getUint32(total - 4, true);
  expect(last).toBe(body);
  expect(decodeValue("as", bytes)).toEqual(value);
});
it("rejects offsets wider than the container needs", () => {
  // 253 bytes of data and two offsets fit in 255 bytes, so two-byte offsets are not normal.
  const bytes = new Uint8Array(257);
  bytes.fill(97, 0, 252);
  bytes.set([0, 0, 252, 0, 253, 0], 251);
  expect(() => decodeValue("as", bytes)).toThrow(GVariantDecodeError);
});
