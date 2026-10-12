// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { Entry } from "./corpus.ts";
import { characterSample, difference, exactSample, ratio, type Estimate, type Sample } from "./metrics.ts";

/** One sentence and each engine's normalised output. */
export interface Conversion {
  readonly entry: Entry;
  readonly libpinyin: string;
  readonly rime: string;
}

export interface Scores {
  readonly exact: Estimate;
  readonly character: Estimate;
}

export interface Group {
  readonly label: string;
  readonly sentences: number;
  readonly libpinyin: Scores;
  readonly rime: Scores;
  /** libpinyin's scores less Rime's. */
  readonly difference: Scores;
}

export interface Summary {
  readonly overall: Group;
  readonly byLength: readonly Group[];
  /** Whether libpinyin is ahead on both metrics by more than the difference's interval. */
  readonly libpinyinAhead: boolean;
}

/** Sentence lengths in characters, each bucket's bounds inclusive. */
export const lengthBuckets = [
  { label: "8–11", min: 8, max: 11 },
  { label: "12–15", min: 12, max: 15 },
  { label: "16–19", min: 16, max: 19 },
  { label: "20 or more", min: 20, max: Infinity },
] as const;

function samples(conversions: readonly Conversion[], engine: "libpinyin" | "rime") {
  const exact: Sample[] = [];
  const character: Sample[] = [];
  for (const conversion of conversions) {
    exact.push(exactSample(conversion.entry.sentence, conversion[engine]));
    character.push(characterSample(conversion.entry.sentence, conversion[engine]));
  }
  return { exact, character };
}

function group(label: string, conversions: readonly Conversion[]): Group {
  const libpinyin = samples(conversions, "libpinyin");
  const rime = samples(conversions, "rime");
  return {
    label,
    sentences: conversions.length,
    libpinyin: { exact: ratio(libpinyin.exact), character: ratio(libpinyin.character) },
    rime: { exact: ratio(rime.exact), character: ratio(rime.character) },
    difference: {
      exact: difference(libpinyin.exact, rime.exact),
      character: difference(libpinyin.character, rime.character),
    },
  };
}

export function summarise(conversions: readonly Conversion[]): Summary {
  const overall = group("All", conversions);
  return {
    overall,
    byLength: lengthBuckets.map((bucket) =>
      group(
        bucket.label,
        conversions.filter((conversion) => {
          const length = [...conversion.entry.sentence].length;
          return length >= bucket.min && length <= bucket.max;
        }),
      ),
    ),
    libpinyinAhead: overall.difference.exact.low > 0 && overall.difference.character.low > 0,
  };
}
