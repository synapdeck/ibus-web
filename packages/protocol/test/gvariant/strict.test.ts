// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it } from "vitest";
import { decodeValue, GVariantDecodeError } from "../../src/index.ts";
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
