// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { minimumLength, normalise, parseCorpus } from "./corpus.ts";

const header = "id\tsentence\tpinyin\n";

describe("parseCorpus", () => {
  test("reads the committed corpus", () => {
    const entries = parseCorpus(readFileSync(new URL("corpus.tsv", import.meta.url), "utf8"));
    expect(entries).toHaveLength(1000);
    expect(new Set(entries.map((entry) => entry.sentence)).size).toBe(1000);
    for (const entry of entries) {
      expect(normalise(entry.sentence)).toBe(entry.sentence);
      expect([...entry.sentence].length).toBeGreaterThanOrEqual(minimumLength);
    }
  });

  test("reads each row's id, sentence and pinyin", () => {
    expect(
      parseCorpus(
        `${header}3\t我们明天去北京吧\twomenmingtianqubeijingba\n7\t绿色的女人喜欢学习\tlvsedenvrenxihuanxuexi\n`,
      ),
    ).toEqual([
      { id: 3, sentence: "我们明天去北京吧", pinyin: "womenmingtianqubeijingba" },
      { id: 7, sentence: "绿色的女人喜欢学习", pinyin: "lvsedenvrenxihuanxuexi" },
    ]);
  });

  test.each([
    ["a header of other columns", "id\tsentence\n", "the header"],
    ["no final newline", `${header}3\t我们明天去北京吧\twomenmingtianqubeijingba`, "no newline"],
    ["a missing field", `${header}3\t我们明天去北京吧\n`, "2 fields"],
    ["an id that isn't a number", `${header}x3\t我们明天去北京吧\twomenmingtianqubeijingba\n`, "positive integer"],
    ["punctuation in a sentence", `${header}3\t我们明天去北京吧！\twomenmingtianqubeijingba\n`, "Han characters"],
    ["a short sentence", `${header}3\t我们去北京吧\twomenqubeijingba\n`, "8 or more"],
    ["pinyin with a separator", `${header}3\t我们明天去北京吧\twomen'mingtianqubeijingba\n`, "lowercase letters"],
    [
      "ids out of order",
      `${header}7\t我们明天去北京吧\twomenmingtianqubeijingba\n3\t绿色的女人喜欢学习\tlvsedenvrenxihuanxuexi\n`,
      "ascending",
    ],
  ])("rejects %s", (_, text, message) => {
    expect(() => parseCorpus(text)).toThrow(message);
  });
});

describe("normalise", () => {
  test("removes punctuation, symbols and spaces, full-width or not", () => {
    expect(normalise("“你好，世界！”　我们…走吧～ ok?")).toBe("你好世界我们走吧ok");
  });

  test("keeps letters and digits, which an engine is scored for", () => {
    expect(normalise("你好nihao123")).toBe("你好nihao123");
  });

  test("composes", () => {
    expect(normalise("lü")).toBe("lü");
  });
});
