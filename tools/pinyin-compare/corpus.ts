// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

export interface Entry {
  /** Tatoeba's sentence id. */
  readonly id: number;
  readonly sentence: string;
  /** Toneless pinyin without separators, ü spelled v. */
  readonly pinyin: string;
}

export const minimumLength = 8;

const header = "id\tsentence\tpinyin";

/** Parses corpus.tsv, failing on any row the generator couldn't have written. */
export function parseCorpus(text: string): Entry[] {
  const lines = text.split("\n");
  if (lines[0] !== header) {
    throw new Error(`corpus: the header isn't ${JSON.stringify(header)}`);
  }
  if (lines.at(-1) !== "") {
    throw new Error("corpus: the last line has no newline");
  }

  const entries: Entry[] = [];
  for (const [index, line] of lines.slice(1, -1).entries()) {
    const where = `corpus line ${index + 2}`;
    const fields = line.split("\t");
    if (fields.length !== 3) {
      throw new Error(`${where}: ${fields.length} fields, not 3`);
    }

    const [id, sentence, pinyin] = fields as [string, string, string];
    if (!/^[1-9][0-9]*$/.test(id)) {
      throw new Error(`${where}: the id ${JSON.stringify(id)} isn't a positive integer`);
    }
    if (!/^\p{Unified_Ideograph}+$/u.test(sentence) || [...sentence].length < minimumLength) {
      throw new Error(`${where}: the sentence isn't ${minimumLength} or more Han characters`);
    }
    if (!/^[a-z]+$/.test(pinyin)) {
      throw new Error(`${where}: the pinyin isn't lowercase letters alone`);
    }

    const previous = entries.at(-1);
    if (previous !== undefined && previous.id >= Number(id)) {
      throw new Error(`${where}: the ids aren't in ascending order`);
    }
    entries.push({ id: Number(id), sentence, pinyin });
  }
  return entries;
}

/**
 * An engine's output as it is compared with the sentence: composed, and
 * without punctuation, symbols or spaces, which the corpus's sentences don't
 * hold. Letters and digits stay, so an engine that leaves pinyin unconverted
 * is scored for it.
 */
export function normalise(text: string): string {
  return text.normalize("NFC").replace(/[\p{P}\p{S}\p{Z}]/gu, "");
}
