// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

const marks = ["", "\u0304", "\u0301", "\u030c", "\u0300"] as const;

// Every vowel pinyin spells, as a lowercase letter, once `v` and `u:` are `ü`.
const vowels = "aeiouü";

// Where a syllable's tone mark goes: on the `a` or `e` it has, in `ou` on
// the `o`, and otherwise on its last vowel. Returns -1 for a syllable
// without a vowel.
export const markIndex = (syllable: string): number => {
  const lower = syllable.toLowerCase();

  const open = lower.search(/[ae]/);
  if (open !== -1) return open;

  const ou = lower.indexOf("ou");
  if (ou !== -1) return ou;

  return Array.from(lower).findLastIndex((letter) => vowels.includes(letter));
};

// `ü` is typed `u:` or, when `vAsU`, `v`.
const umlauted = (letters: string, vAsU: boolean): string => {
  const colons = letters.replace(/([uU]):/g, (_, letter: string) => (letter === "u" ? "ü" : "Ü"));
  if (!vAsU) return colons;

  return colons.replace(/v/g, "ü").replace(/V/g, "Ü");
};

/**
 * Marks one syllable's letters with a tone from 0 to 5. Tones 0 and 5 are
 * neutral and leave the letters bare. A syllable without a vowel has nowhere
 * to take a mark, so there is nothing to return.
 */
export const markSyllable = (letters: string, tone: number, vAsU: boolean): string | undefined => {
  const syllable = umlauted(letters, vAsU);
  const index = markIndex(syllable);
  if (index === -1) return undefined;

  const mark = marks[tone] ?? "";

  // Built from a base letter and a combining mark, which NFC composes, so
  // that `ü` and its capital take marks the same way.
  return (syllable.slice(0, index + 1) + mark + syllable.slice(index + 1)).normalize("NFC");
};

export interface PinyinSettings {
  readonly vAsU: boolean;
}

/**
 * Turns numbered pinyin into tone marks: each run of letters, `ü` and `:` that a
 * digit from 0 to 5 follows is a syllable. A run with no digit or no vowel, and
 * every other character, stays as typed.
 */
export const markPinyin = (input: string, { vAsU }: PinyinSettings): string =>
  input.replace(
    /([A-Za-züÜ:]+)([0-5])/g,
    (typed, letters: string, tone: string) => markSyllable(letters, Number(tone), vAsU) ?? typed,
  );
