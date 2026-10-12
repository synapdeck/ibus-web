// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

/** Levenshtein distance between two strings, counted in code points. */
export function editDistance(a: string, b: string): number {
  const left = [...a];
  const right = [...b];

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [i, x] of left.entries()) {
    const current = [i + 1];
    for (const [j, y] of right.entries()) {
      current.push(Math.min(previous[j + 1]! + 1, current[j]! + 1, previous[j]! + (x === y ? 0 : 1)));
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** One sentence's share of a ratio metric: the metric is Σ numerator / Σ denominator. */
export interface Sample {
  readonly numerator: number;
  readonly denominator: number;
}

/** 1 for a sentence converted exactly, 0 otherwise, over 1. */
export function exactSample(sentence: string, output: string): Sample {
  return { numerator: output === sentence ? 1 : 0, denominator: 1 };
}

/** The sentence's length less the edit distance, over its length. */
export function characterSample(sentence: string, output: string): Sample {
  const length = [...sentence].length;
  return { numerator: length - editDistance(sentence, output), denominator: length };
}

/** A value with its 95 % confidence interval. */
export interface Estimate {
  readonly value: number;
  readonly low: number;
  readonly high: number;
}

const z = 1.959963984540054;

// The standard error of a ratio of sums over sentences sampled at random,
// by linearisation: each sentence contributes its numerator less the ratio's
// share of its denominator. For exact-sentence accuracy that is the familiar
// sqrt(p(1 - p)/n), corrected for one degree of freedom.
function interval(value: number, residuals: readonly number[], denominator: number): Estimate {
  const n = residuals.length;
  if (n < 2) {
    throw new Error("an interval needs two sentences or more");
  }
  const squares = residuals.reduce((sum, residual) => sum + residual * residual, 0);
  const margin = (z * Math.sqrt((n / (n - 1)) * squares)) / denominator;
  return { value, low: value - margin, high: value + margin };
}

function total(samples: readonly Sample[], field: keyof Sample): number {
  return samples.reduce((sum, sample) => sum + sample[field], 0);
}

/** A ratio metric over the samples. */
export function ratio(samples: readonly Sample[]): Estimate {
  const denominator = total(samples, "denominator");
  const value = total(samples, "numerator") / denominator;
  return interval(
    value,
    samples.map((sample) => sample.numerator - value * sample.denominator),
    denominator,
  );
}

/**
 * The difference a − b between one ratio metric of two engines over the same
 * sentences. Pairing the sentences gives a narrower interval than the two
 * engines' own intervals would, since a sentence hard for one engine is
 * usually hard for the other.
 */
export function difference(a: readonly Sample[], b: readonly Sample[]): Estimate {
  if (a.length !== b.length || a.some((sample, index) => sample.denominator !== b[index]!.denominator)) {
    throw new Error("a difference needs the same sentences on both sides");
  }

  const denominator = total(a, "denominator");
  const valueA = total(a, "numerator") / denominator;
  const valueB = total(b, "numerator") / denominator;
  return interval(
    valueA - valueB,
    a.map(
      (sample, index) =>
        sample.numerator - valueA * sample.denominator - (b[index]!.numerator - valueB * sample.denominator),
    ),
    denominator,
  );
}
