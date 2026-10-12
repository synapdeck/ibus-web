// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, test } from "vitest";
import { summarise, type Conversion } from "./summary.ts";

const sentences = [
  "我们明天去北京吧",
  "绿色的女人喜欢学习",
  "以前读高中的时候我每天早",
  "这一消息证实了我的怀疑吗",
  "以前读高中的时候我每天早上六点钟",
  "我将确保你们在第一年后有一个增长",
  "以前读高中的时候我每天早上六点起床",
  "我将确保你们在第一年后有一个增长和发展",
  "以前读高中的时候我每天早上六点起床去学校",
  "我将确保你们在第一年后有一个增长和很大发展",
];

function conversions(libpinyin: (sentence: string) => string, rime: (sentence: string) => string): Conversion[] {
  return sentences.map((sentence, index) => ({
    entry: { id: index + 1, sentence, pinyin: "x" },
    libpinyin: libpinyin(sentence),
    rime: rime(sentence),
  }));
}

const same = (sentence: string) => sentence;
const wrongFirst = (sentence: string) => `错${sentence.slice(1)}`;

describe("summarise", () => {
  test("groups the sentences by length", () => {
    const summary = summarise(conversions(same, same));
    expect(summary.overall.sentences).toBe(10);
    expect(summary.byLength.map((group) => [group.label, group.sentences])).toEqual([
      ["8–11", 2],
      ["12–15", 2],
      ["16–19", 4],
      ["20 or more", 2],
    ]);
  });

  test("scores each engine and the difference", () => {
    const summary = summarise(conversions(same, wrongFirst));
    expect(summary.overall.libpinyin.exact.value).toBe(1);
    expect(summary.overall.rime.exact.value).toBe(0);
    expect(summary.overall.difference.exact).toEqual({ value: 1, low: 1, high: 1 });
    const characters = sentences.reduce((sum, sentence) => sum + sentence.length, 0);
    expect(summary.overall.rime.character.value).toBeCloseTo(1 - sentences.length / characters, 12);
  });

  test("finds libpinyin ahead only past both differences' intervals", () => {
    expect(summarise(conversions(same, wrongFirst)).libpinyinAhead).toBe(true);
    expect(summarise(conversions(wrongFirst, same)).libpinyinAhead).toBe(false);
    expect(summarise(conversions(same, same)).libpinyinAhead).toBe(false);
  });
});
