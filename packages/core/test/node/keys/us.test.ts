// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import { usKeysym } from "../../../src/keys/us.ts";
import { keysymByName } from "../../../src/keys/keysyms.generated.ts";
import { validateKeyboard } from "../../../src/keys/manifest.ts";
test("keypad selection ignores Shift and Lock", () =>
  expect(usKeysym(79, "Numpad1", true, true, false)).toBe(keysymByName.get("KP_End")));
test("pass-through names checked by core", () => {
  expect(validateKeyboard({ layout: "us", passThrough: ["Escape"] })).toEqual({
    layout: "us",
    passThrough: ["Escape"],
  });
  expect(() => validateKeyboard({ layout: "us", passThrough: ["Escpae"] })).toThrow();
});
