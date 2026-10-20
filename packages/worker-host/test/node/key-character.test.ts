// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The text processKey receives for a keyval, from keyboards of several
// scripts.

import { expect, test } from "vitest";
import { keyCharacter } from "../../src/worker/key-character.ts";

test("a key stands for its character on Latin, Cyrillic, Greek and kana keyboards, and as a Unicode keysym", () => {
  const characters: [string, number, string][] = [
    ["a", 0x61, "a"],
    ["eacute", 0xe9, "é"],
    ["Cyrillic_a", 0x6c1, "а"],
    ["Cyrillic_SHCHA", 0x6fd, "Щ"],
    ["Greek_alpha", 0x7e1, "α"],
    ["Greek_OMEGA", 0x7d9, "Ω"],
    ["kana_A", 0x4b1, "ア"],
    ["kana_tsu", 0x4af, "ッ"],
    ["U+1F600", 0x0101f600, "😀"],
    ["KP_5", 0xffb5, "5"],
  ];
  for (const [name, keyval, character] of characters) expect(keyCharacter(keyval), name).toBe(character);
});

test("a control key, a keysym that stands for nothing and a surrogate keysym stand for no text", () => {
  for (const keyval of [0xff08, 0xff0d, 0xff1b, 0xffff, 0x01000085, 0xffe1, 0xff31, 0x0100d800])
    expect(keyCharacter(keyval), keyval.toString(16)).toBe("");
});
