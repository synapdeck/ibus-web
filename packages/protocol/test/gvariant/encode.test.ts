// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, it } from "vitest";
import { encodeValue, ProtocolError, type GVariantValue } from "../../src/index.ts";

describe("encodeValue", () => {
  it.each<[string, GVariantValue]>([
    ["y", { _tag: "y", value: 256 }],
    ["y", { _tag: "y", value: -1 }],
    ["n", { _tag: "n", value: 40000 }],
    ["q", { _tag: "q", value: 65536 }],
    ["i", { _tag: "i", value: 1.5 }],
    ["i", { _tag: "i", value: 2 ** 31 }],
    ["u", { _tag: "u", value: -1 }],
    ["u", { _tag: "u", value: Number.NaN }],
    ["h", { _tag: "h", value: Number.POSITIVE_INFINITY }],
    ["x", { _tag: "x", value: 2n ** 63n }],
    ["x", { _tag: "x", value: -(2n ** 63n) - 1n }],
    ["t", { _tag: "t", value: -1n }],
    ["t", { _tag: "t", value: 2n ** 64n }],
    ["o", { _tag: "o", value: "a//b" }],
    ["o", { _tag: "o", value: "/a/" }],
    ["o", { _tag: "o", value: "" }],
    ["g", { _tag: "g", value: "(u" }],
    ["g", { _tag: "g", value: "mi" }],
    ["g", { _tag: "g", value: "a{vs}" }],
    ["g", { _tag: "g", value: "a".repeat(129) + "y" }],
  ])("rejects %s %o", (signature, value) => {
    expect(() => encodeValue(signature, value)).toThrow(ProtocolError);
  });

  it.each<[string, GVariantValue]>([
    ["y", { _tag: "y", value: 255 }],
    ["n", { _tag: "n", value: -32768 }],
    ["i", { _tag: "i", value: -0 }],
    ["d", { _tag: "d", value: Number.NaN }],
    ["x", { _tag: "x", value: -(2n ** 63n) }],
    ["t", { _tag: "t", value: 2n ** 64n - 1n }],
    ["o", { _tag: "o", value: "/" }],
    ["g", { _tag: "g", value: "{sv}" }],
    ["g", { _tag: "g", value: "a".repeat(128) + "()" }],
  ])("accepts %s %o", (signature, value) => {
    expect(() => encodeValue(signature, value)).not.toThrow();
  });

  it("refuses to nest past GLib's recursion limit", () => {
    const nested = (levels: number): GVariantValue =>
      levels === 0 ? { _tag: "y", value: 5 } : { _tag: "a", items: [nested(levels - 1)] };
    expect(() => encodeValue("a".repeat(127) + "y", nested(127))).not.toThrow();
    expect(() => encodeValue("a".repeat(128) + "y", nested(128))).toThrow(ProtocolError);
    const variants = (levels: number): GVariantValue =>
      levels === 1
        ? { _tag: "v", type: "y", value: { _tag: "y", value: 1 } }
        : { _tag: "v", type: "v", value: variants(levels - 1) };
    expect(() => encodeValue("v", variants(127))).not.toThrow();
    expect(() => encodeValue("v", variants(128))).toThrow(ProtocolError);
  });

  it("counts the depth of a variant's type", () => {
    const variant = (levels: number): GVariantValue => ({
      _tag: "v",
      type: "a".repeat(levels) + "y",
      value: { _tag: "a", items: [] },
    });
    expect(() => encodeValue("v", variant(126))).not.toThrow();
    expect(() => encodeValue("v", variant(127))).toThrow(ProtocolError);
  });
});
