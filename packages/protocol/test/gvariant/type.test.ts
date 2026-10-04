// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "vitest";
import { parseType, ProtocolError } from "../../src/index.ts";

describe("GVariant types", () => {
  it.each([
    ["b", 1, 1],
    ["y", 1, 1],
    ["n", 2, 2],
    ["q", 2, 2],
    ["i", 4, 4],
    ["u", 4, 4],
    ["h", 4, 4],
    ["x", 8, 8],
    ["t", 8, 8],
    ["d", 8, 8],
    ["s", 1, undefined],
    ["o", 1, undefined],
    ["g", 1, undefined],
    ["v", 8, undefined],
    ["()", 1, 1],
    ["(yu)", 4, 8],
    ["(uy)", 4, 8],
    ["(ty)", 8, 16],
    ["{yu}", 4, 8],
    ["(sy)", 1, undefined],
    ["as", 1, undefined],
    ["ay", 1, undefined],
    ["mi", 4, undefined],
  ])("lays out %s", (signature, alignment, fixedSize) => {
    expect(parseType(signature as string)).toMatchObject({ signature, alignment, fixedSize });
  });
  it.each(["a{sv}", "(ua{sa{sv}})", "(sa{sv}uubbiavav)"])("round trips %s", (signature) => {
    expect(parseType(signature).signature).toBe(signature);
  });
  it.each([
    "",
    "a",
    "(u",
    "u)",
    "{su",
    "{vs}",
    "{sss}",
    "z",
    "uu",
    "r",
    "*",
    "?",
    "a".repeat(129) + "u",
    "(".repeat(129) + "u" + ")".repeat(129),
  ])("rejects %s", (signature) => {
    expect(() => parseType(signature)).toThrow(ProtocolError);
  });
  it("preserves the tagged grammar tree", () => {
    expect(parseType("a{sv}")).toMatchObject({
      _tag: "a",
      element: { _tag: "{}", key: { _tag: "basic", char: "s" }, value: { _tag: "v" } },
    });
    expect(parseType("mi")).toMatchObject({ _tag: "m", element: { _tag: "basic", char: "i" } });
    expect(parseType("(yu)")).toMatchObject({ _tag: "()", members: [{ char: "y" }, { char: "u" }] });
  });
  it("accepts exactly 128 levels of containers", () => {
    for (const signature of ["a".repeat(128) + "u", "(".repeat(128) + "u" + ")".repeat(128)]) {
      expect(parseType(signature).signature).toBe(signature);
    }
    expect(() => parseType("a".repeat(128) + "()")).toThrow(ProtocolError);
  });
  it("memoizes immutable types", () => {
    const type = parseType("(yu)");
    expect(parseType("(yu)")).toBe(type);
    expect(Object.isFrozen(type)).toBe(true);
    if (type._tag === "()") expect(Object.isFrozen(type.members)).toBe(true);
  });
});
