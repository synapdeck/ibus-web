// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, test } from "vitest";
import { characterSample, difference, editDistance, exactSample, ratio, type Sample } from "./metrics.ts";

const z = 1.959963984540054;

describe("editDistance", () => {
  test.each([
    ["", "", 0],
    ["", "北京", 2],
    ["我们去北京吧", "我们去北京吧", 0],
    ["我们去北京吧", "我们去背景吧", 2],
    ["我们去北京吧", "我们北京吧", 1],
    ["我们去北京吧", "我们去了北京吧", 1],
    ["kitten", "sitting", 3],
    // One character outside the Basic Multilingual Plane, two UTF-16 units.
    ["𠀀好", "好", 1],
  ])("from %j to %j is %i", (a, b, distance) => {
    expect(editDistance(a, b)).toBe(distance);
    expect(editDistance(b, a)).toBe(distance);
  });
});

describe("samples", () => {
  test("an exact sentence counts 1 of 1, any other 0 of 1", () => {
    expect(exactSample("我们去北京吧", "我们去北京吧")).toEqual({ numerator: 1, denominator: 1 });
    expect(exactSample("我们去北京吧", "我们去背景吧")).toEqual({ numerator: 0, denominator: 1 });
  });

  test("a sentence's characters count its length less the edit distance", () => {
    expect(characterSample("我们去北京吧", "我们去背景吧")).toEqual({ numerator: 4, denominator: 6 });
  });

  test("an output longer than the sentence can count below zero", () => {
    expect(characterSample("北京", "我们去背景吧")).toEqual({ numerator: -4, denominator: 2 });
  });
});

const exact = (outcomes: readonly number[]): Sample[] => outcomes.map((numerator) => ({ numerator, denominator: 1 }));

describe("ratio", () => {
  test("is the sums' ratio with a 95 % interval", () => {
    // Residuals 0.25, -0.75, 0.25, 0.25: their squares sum to 0.75, and
    // 4/3 of that is 1, so the margin is z/4.
    const estimate = ratio(exact([1, 0, 1, 1]));
    expect(estimate.value).toBe(0.75);
    expect(estimate.low).toBeCloseTo(0.75 - z / 4, 12);
    expect(estimate.high).toBeCloseTo(0.75 + z / 4, 12);
  });

  test("weighs each sentence by its denominator", () => {
    const estimate = ratio([
      { numerator: 8, denominator: 8 },
      { numerator: 6, denominator: 12 },
    ]);
    expect(estimate.value).toBe(0.7);
    // Residuals 8 - 0.7 * 8 = 2.4 and 6 - 0.7 * 12 = -2.4.
    expect(estimate.high - estimate.value).toBeCloseTo((z * Math.sqrt(2 * (2 * 2.4 ** 2))) / 20, 12);
  });

  test("has no interval for one sentence", () => {
    expect(() => ratio(exact([1]))).toThrow("two sentences");
  });
});

describe("difference", () => {
  test("pairs the sentences", () => {
    // Paired residuals -0.25, 0.75, -0.25, -0.25: the margin is z/4 again.
    const estimate = difference(exact([1, 1, 0, 1]), exact([1, 0, 0, 1]));
    expect(estimate.value).toBe(0.25);
    expect(estimate.low).toBeCloseTo(0.25 - z / 4, 12);
    expect(estimate.high).toBeCloseTo(0.25 + z / 4, 12);
  });

  test("is exact when the engines differ the same way on every sentence", () => {
    expect(difference(exact([1, 1, 1]), exact([0, 0, 0]))).toEqual({ value: 1, low: 1, high: 1 });
  });

  test("needs the same sentences on both sides", () => {
    expect(() => difference(exact([1, 1]), exact([1]))).toThrow("same sentences");
    expect(() =>
      difference(
        [
          { numerator: 1, denominator: 8 },
          { numerator: 1, denominator: 8 },
        ],
        [
          { numerator: 1, denominator: 8 },
          { numerator: 1, denominator: 9 },
        ],
      ),
    ).toThrow("same sentences");
  });
});
