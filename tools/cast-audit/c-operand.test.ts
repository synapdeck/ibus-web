// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, test } from "vitest";
import { castOperandName } from "./c-operand.ts";

// Each location identifies the start of the cast, as Clang's SARIF does.
describe.each(["c", "cpp"] as const)("%s cast operands", (language) => {
  test.each([
    ["(GFunc)one", "one"],
    ["(GFunc) /* callback */ one", "one"],
    ["(GFunc)\n  one", "one"],
    ["(GFunc)(one)", null],
    ["(GFunc)&one", null],
    ["(GFunc)callbacks[index]", null],
    ["(GFunc)factory()", null],
    ["(GFunc)(ready ? one : two)", null],
  ])("identifies only plain identifiers: %s", (expression, expected) => {
    const source = `void f() { GFunc value = ${expression}; }`;
    expect(castOperandName(source, { startLine: 1, startColumn: 26 }, language)).toBe(expected);
  });
  test("does not confuse a comment with the cast location", () => {
    const source = "/* (GFunc)wrong */\nvoid f() { GFunc value = (GFunc)right; }";
    expect(castOperandName(source, { startLine: 2, startColumn: 26 }, language)).toBe("right");
  });
  test("accounts for Unicode code-point columns before the cast", () => {
    const source = "void f() { /* 🌱 */ GFunc value = (GFunc)one; }";
    expect(castOperandName(source, { startLine: 1, startColumn: 34 }, language)).toBe("one");
  });
  test("does not guess an operand for a macro invocation", () => {
    const source = "void f() { GFunc value = CAST(one); }";
    expect(castOperandName(source, { startLine: 1, startColumn: 26 }, language)).toBeNull();
  });
});
