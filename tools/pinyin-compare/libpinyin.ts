// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { execFileSync } from "node:child_process";

/** Each pinyin's sentence from libpinyin-convert, in order. */
export function convertWithLibpinyin(
  program: string,
  dataDir: string,
  userDir: string,
  pinyins: readonly string[],
): string[] {
  const output = execFileSync(program, [dataDir, userDir], {
    input: pinyins.map((pinyin) => `${pinyin}\n`).join(""),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });

  const sentences = output.split("\n");
  if (sentences.pop() !== "" || sentences.length !== pinyins.length) {
    throw new Error(`libpinyin-convert gave ${sentences.length} lines for ${pinyins.length} inputs`);
  }
  return sentences;
}
