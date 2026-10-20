// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, test } from "vitest";
import { markIndex, markPinyin, markSyllable } from "../src/pinyin.ts";

const on = { vAsU: true };
const off = { vAsU: false };

// Each vowel with its four marked forms, spelled out so that the expected
// text doesn't come from the combining marks the code builds it from.
const marked: Record<string, readonly [string, string, string, string]> = {
  a: ["ā", "á", "ǎ", "à"],
  e: ["ē", "é", "ě", "è"],
  i: ["ī", "í", "ǐ", "ì"],
  o: ["ō", "ó", "ǒ", "ò"],
  u: ["ū", "ú", "ǔ", "ù"],
  ü: ["ǖ", "ǘ", "ǚ", "ǜ"],
};

// Every vowel cluster pinyin has, with the position of the letter that takes
// the mark.
const clusters: ReadonlyArray<readonly [cluster: string, at: number]> = [
  ["a", 0],
  ["e", 0],
  ["i", 0],
  ["o", 0],
  ["u", 0],
  ["ü", 0],
  ["ai", 0],
  ["ei", 0],
  ["ao", 0],
  ["ou", 0],
  ["an", 0],
  ["en", 0],
  ["ang", 0],
  ["eng", 0],
  ["ong", 0],
  ["er", 0],
  ["ia", 1],
  ["ie", 1],
  ["iao", 1],
  ["iu", 1],
  ["ian", 1],
  ["in", 0],
  ["iang", 1],
  ["ing", 0],
  ["iong", 1],
  ["ua", 1],
  ["uo", 1],
  ["uai", 1],
  ["ui", 1],
  ["uan", 1],
  ["un", 0],
  ["uang", 1],
  ["ueng", 1],
  ["üe", 1],
  ["üan", 1],
  ["ün", 0],
];

const withMark = (syllable: string, at: number, tone: number): string => {
  const letter = syllable[at]!;
  return syllable.slice(0, at) + marked[letter]![tone - 1] + syllable.slice(at + 1);
};

describe("markIndex", () => {
  test.each(clusters)("puts the mark of %s on its letter %i", (cluster, at) => {
    expect(markIndex(cluster)).toBe(at);
    expect(markIndex(`zh${cluster}`)).toBe(at + 2);
  });

  test("finds no place in a syllable without a vowel", () => {
    expect(markIndex("hm")).toBe(-1);
    expect(markIndex("ng")).toBe(-1);
  });

  test("puts the mark on the o of ou, wherever the syllable starts", () => {
    expect(markIndex("gou")).toBe(1);
    expect(markIndex("Lou")).toBe(1);
  });
});

describe("markSyllable", () => {
  describe.each(clusters)("%s", (cluster, at) => {
    const initials = cluster.startsWith("ü") || cluster.startsWith("ün") ? ["", "l", "n"] : ["", "b", "zh"];

    test.each([1, 2, 3, 4])("in tone %i, after each initial", (tone) => {
      for (const initial of initials) {
        // ü is typed v when the setting is on.
        const typed = initial + cluster.replace("ü", "v");
        expect(markSyllable(typed, tone, true)).toBe(withMark(initial + cluster, initial.length + at, tone));
      }
    });
  });

  test("leaves a neutral syllable bare for tone 5 and tone 0", () => {
    expect(markSyllable("ma", 5, true)).toBe("ma");
    expect(markSyllable("ma", 0, true)).toBe("ma");
    expect(markSyllable("lv", 5, true)).toBe("lü");
  });

  test("keeps the case of every letter", () => {
    expect(markSyllable("Ni", 3, true)).toBe("Nǐ");
    expect(markSyllable("HAO", 3, true)).toBe("HǍO");
    expect(markSyllable("Ou", 1, true)).toBe("Ōu");
    expect(markSyllable("LV", 4, true)).toBe("L\u01db");
    expect(markSyllable("Lv", 4, true)).toBe("Lǜ");
    expect(markSyllable("NU:", 3, true)).toBe("N\u01d9");
  });

  test("has nothing to return for a syllable without a vowel", () => {
    expect(markSyllable("hm", 2, true)).toBeUndefined();
    expect(markSyllable("ng", 2, true)).toBeUndefined();
  });
});

describe("the setting", () => {
  test("reads v as ü when on", () => {
    expect(markPinyin("lv4", on)).toBe("lǜ");
    expect(markPinyin("nv3", on)).toBe("nǚ");
    expect(markPinyin("LV4", on)).toBe("L\u01db");
    expect(markPinyin("lve4", on)).toBe("lüè");
    expect(markPinyin("nv5", on)).toBe("nü");
  });

  test("leaves v alone when off, which leaves a syllable of no vowel as typed", () => {
    expect(markPinyin("lv4", off)).toBe("lv4");
    expect(markPinyin("nv5", off)).toBe("nv5");
  });

  test("takes ü typed as itself either way", () => {
    for (const settings of [on, off]) {
      expect(markPinyin("lü4", settings)).toBe("lǜ");
      expect(markPinyin("nüe4", settings)).toBe("nüè");
      expect(markPinyin("LÜ4", settings)).toBe("L\u01db");
    }
  });

  test("reads u: as ü either way", () => {
    for (const settings of [on, off]) {
      expect(markPinyin("lu:4", settings)).toBe("lǜ");
      expect(markPinyin("nu:3", settings)).toBe("nǚ");
      expect(markPinyin("lu:e4", settings)).toBe("lüè");
      expect(markPinyin("LU:4", settings)).toBe("L\u01db");
    }
  });

  test("still marks the other vowels around a v that stays", () => {
    expect(markPinyin("lve4", off)).toBe("lvè");
  });
});

describe("markPinyin", () => {
  test("marks each syllable of several", () => {
    expect(markPinyin("ni3 hao3", on)).toBe("nǐ hǎo");
    expect(markPinyin("ni3hao3", on)).toBe("nǐhǎo");
    expect(markPinyin("zhong1guo2ren2", on)).toBe("zhōngguórén");
    expect(markPinyin("Zhong1 Guo2", on)).toBe("Zhōng Guó");
    expect(markPinyin("lv4 se4", on)).toBe("lǜ sè");
  });

  test("marks a syllable that follows an apostrophe", () => {
    expect(markPinyin("xi1'an1", on)).toBe("xī'ān");
  });

  test("leaves a syllable without a number as typed", () => {
    expect(markPinyin("ni", on)).toBe("ni");
    expect(markPinyin("lv", on)).toBe("lv");
    expect(markPinyin("lu:", on)).toBe("lu:");
    expect(markPinyin("ni3hao", on)).toBe("nǐhao");
    expect(markPinyin("ni hao3", on)).toBe("ni hǎo");
    expect(markPinyin("", on)).toBe("");
  });

  test("leaves digits that no letter precedes as typed", () => {
    expect(markPinyin("3", on)).toBe("3");
    expect(markPinyin("ni33", on)).toBe("nǐ3");
  });

  test("gives the same text for tone numbers 0 and 5", () => {
    expect(markPinyin("de5", on)).toBe("de");
    expect(markPinyin("de0", on)).toBe("de");
  });
});
