// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseKeysyms } from "./keysymdef.ts";
test("annotations select canonical and directional character mappings", () => {
  const maps = parseKeysyms(`
#define XK_eacute 0x00e9 /* U+00E9 LATIN SMALL LETTER E WITH ACUTE */
#define XK_alias 0x00e9 // alias for eacute
#define XK_space 0x0020 // U+0020 SPACE
#define XK_KP_Space 0xff80 //<U+0020 SPACE>
#define XK_legacy 0x0100 /* (U+0041 LATIN CAPITAL LETTER A) */
#define XK_Hangul 0xff31
`);
  expect([...maps.byName]).toEqual([
    ["eacute", 233],
    ["alias", 233],
    ["space", 32],
    ["KP_Space", 65408],
    ["legacy", 256],
    ["Hangul", 65329],
  ]);
  expect([...maps.canonicalName]).toEqual([
    [233, "eacute"],
    [32, "space"],
    [65408, "KP_Space"],
    [256, "legacy"],
    [65329, "Hangul"],
  ]);
  expect([...maps.byCodepoint]).toEqual([
    [233, 233],
    [32, 32],
  ]);
  expect([...maps.byKeysym]).toEqual([
    [233, 233],
    [32, 32],
    [65408, 32],
    [256, 65],
  ]);
});
test("pinned X11 names and Korean legacy mapping", () => {
  const source = process.env["IBUS_WEB_KEYSYMDEF"];
  if (source === undefined) throw new Error("IBUS_WEB_KEYSYMDEF is required");
  const maps = parseKeysyms(readFileSync(source, "utf8"));
  expect(maps.byName.get("a")).toBe(0x61);
  expect(maps.byName.get("Hangul")).toBe(0xff31);
  expect(maps.byName.get("Hangul_Hanja")).toBe(0xff34);
  expect(maps.byCodepoint.get(0x3131)).toBe(0xea1);
});
