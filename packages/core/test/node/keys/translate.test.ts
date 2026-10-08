// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import { translateKey } from "../../../src/keys/translate.ts";
const event = (code: string, key = "a", mods: string[] = [], type = "keydown") => ({
  code,
  key,
  type,
  repeat: false,
  isComposing: false,
  getModifierState: (name: string) => mods.includes(name),
});
test.each([
  [[], 103],
  [["Shift"], 71],
  [["CapsLock"], 71],
  [["Shift", "CapsLock"], 103],
] as const)("US letters %j", (mods, keyval) =>
  expect(translateKey(event("KeyG", "a", [...mods]), "us")).toEqual({
    keyval,
    keycode: 34,
    state: mods.reduce((s, m) => s | (m === "Shift" ? 1 : 2), 0),
  }),
);
test("US physical symbols and keypad", () => {
  expect(translateKey(event("KeyQ", "a"), "us")?.keyval).toBe(113);
  expect(translateKey(event("Digit1", "1", ["Shift"]), "us")?.keyval).toBe(33);
  expect(translateKey(event("Numpad1", "1"), "us")?.keyval).toBe(0xff9c);
  expect(translateKey(event("Numpad1", "1", ["NumLock"]), "us")?.keyval).toBe(0xffb1);
  expect(translateKey(event("Space", " "), "us")?.keycode).toBe(57);
});
test.each(["us", "default"] as const)("composition and language keys %s", (layout) => {
  expect(translateKey({ ...event("KeyA"), isComposing: true }, layout)).toBeUndefined();
  expect(translateKey(event("KeyA", "Dead"), layout)).toBeUndefined();
  expect(translateKey(event("Lang1", "HangulMode"), layout)).toMatchObject({ keyval: 0xff31, keycode: 122 });
  expect(translateKey(event("Lang2", "HanjaMode"), layout)).toMatchObject({ keyval: 0xff34, keycode: 123 });
});
test("default characters and named keys", () => {
  for (const [key, keyval] of [
    ["é", 233],
    ["α", 0x7e1],
    ["😀", 0x101f600],
    ["Backspace", 0xff08],
    ["ArrowLeft", 0xff51],
    ["Shift", 0xffe1],
    ["Enter", 0xff0d],
    ["Escape", 0xff1b],
    ["F12", 0xffc9],
  ] as const)
    expect(translateKey(event("KeyA", key), "default")?.keyval).toBe(keyval);
});
test("IBus modifiers and release", () => {
  expect(translateKey(event("KeyA", "a", ["Control", "Alt", "Meta", "AltGraph"], "keyup"), "us")?.state).toBe(
    0x40000000 | 0x4000000 | 0x10000000 | 64 | 128,
  );
});
test.each([
  ["Control", 4],
  ["Alt", 8],
  ["Meta", 0x14000040],
  ["AltGraph", 128],
  ["NumLock", 16],
] as const)("modifier %s", (mod, state) => expect(translateKey(event("KeyA", "a", [mod]), "us")?.state).toBe(state));
test("all function keys and named US keys", () => {
  for (let n = 1; n <= 12; n++) expect(translateKey(event(`F${n}`, `F${n}`), "default")?.keyval).toBe(0xffbd + n);
  for (const [code, key, keyval] of [
    ["Backspace", "Backspace", 0xff08],
    ["ArrowLeft", "ArrowLeft", 0xff51],
    ["Enter", "Enter", 0xff0d],
    ["Escape", "Escape", 0xff1b],
    ["ShiftLeft", "Shift", 0xffe1],
  ] as const)
    expect(translateKey(event(code, key), "us")?.keyval).toBe(keyval);
  expect(translateKey(event("Unidentified", "Unidentified"), "us")).toBeUndefined();
});

test("named key fallback uses UI Events values in both layouts", () => {
  for (const layout of ["us", "default"] as const)
    expect(translateKey(event("", "Backspace"), layout)?.keyval).toBe(0xff08);
});
