// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import {
  keysymForCodepoint,
  codepointForKeysym,
  keysymByName,
} from "../../packages/core/src/keys/keysyms.generated.ts";
import { evdevForCode } from "../../packages/core/src/keys/dom-codes.generated.ts";
test("generated mappings preserve legacy characters and Unicode scalars", () => {
  expect(keysymForCodepoint(0x3131)).toBe(0xea1);
  expect(codepointForKeysym(0xea1)).toBe(0x3131);
  expect(keysymForCodepoint(0x1f600)).toBe(0x0101f600);
  expect(codepointForKeysym(0x0101f600)).toBe(0x1f600);
  expect(codepointForKeysym(0xff80)).toBe(0x20);
  expect(keysymForCodepoint(0x20)).toBe(0x20);
  for (const cp of [-1, 0xd800, 0xdfff, 0x110000, 1.5, NaN]) expect(keysymForCodepoint(cp)).toBeUndefined();
  for (const sym of [-1, 0x01000061, 0x0100d800, 0x01110000, 1.5, NaN]) expect(codepointForKeysym(sym)).toBeUndefined();
  expect(keysymByName.get("Hangul")).toBe(0xff31);
  expect(keysymByName.get("Hangul_Hanja")).toBe(0xff34);
  expect(keysymByName.get("unknown")).toBeUndefined();
  expect(evdevForCode("KeyA")).toBe(30);
  expect(evdevForCode("Lang1")).toBe(122);
  expect(evdevForCode("Lang2")).toBe(123);
  expect(evdevForCode("Space")).toBe(57);
  expect(evdevForCode("Hyper")).toBeUndefined();
  expect(evdevForCode("unknown")).toBeUndefined();
});
