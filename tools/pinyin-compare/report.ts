// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// report.ts --corpus <corpus.tsv> --out <directory> --libpinyin-convert <program> --libpinyin-data <directory>
//   --rime-session <program> --rime-data <directory> --libpinyin-version <text> --rime-version <text>
//
// Converts the corpus with both engines, each with user data of its own made
// fresh, and writes conversions.tsv, summary.json and report.md to the output
// directory.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { normalise, parseCorpus } from "./corpus.ts";
import { convertWithLibpinyin } from "./libpinyin.ts";
import { type Estimate } from "./metrics.ts";
import { convertWithRime, spawnRimeSession } from "./rime.ts";
import { summarise, type Conversion, type Group, type Summary } from "./summary.ts";

const { values } = parseArgs({
  options: {
    corpus: { type: "string" },
    out: { type: "string" },
    "libpinyin-convert": { type: "string" },
    "libpinyin-data": { type: "string" },
    "rime-session": { type: "string" },
    "rime-data": { type: "string" },
    "libpinyin-version": { type: "string" },
    "rime-version": { type: "string" },
  },
  strict: true,
});

function required(name: keyof typeof values): string {
  const value = values[name];
  if (value === undefined) {
    console.error(`report.ts: --${name} is required`);
    process.exit(2);
  }
  return value;
}

const percent = (value: number) => (value * 100).toFixed(1);
const estimate = (value: Estimate) => `${percent(value.value)} (${percent(value.low)} to ${percent(value.high)})`;

function table(groups: readonly Group[], metric: "exact" | "character"): string {
  const rows = groups.map(
    (group) =>
      `| ${group.label} | ${group.sentences} | ${estimate(group.libpinyin[metric])} | ${estimate(group.rime[metric])} | ${estimate(group.difference[metric])} |`,
  );
  return [
    "| Length | Sentences | libpinyin | Rime | libpinyin − Rime |",
    "| ------ | --------: | --------: | ---: | ---------------: |",
    ...rows,
  ].join("\n");
}

function render(summary: Summary, libpinyinVersion: string, rimeVersion: string): string {
  const groups = [summary.overall, ...summary.byLength];
  const verdict = summary.libpinyinAhead
    ? "libpinyin is ahead on both metrics by more than the difference's 95 % confidence interval."
    : "libpinyin is not ahead on both metrics by more than the difference's 95 % confidence interval.";
  return [
    "# Long-sentence conversion: libpinyin and Rime",
    "",
    `- libpinyin: ${libpinyinVersion}`,
    `- Rime: ${rimeVersion}`,
    "",
    "Percentages, each with its 95 % confidence interval.",
    "",
    "## Exact-sentence accuracy",
    "",
    table(groups, "exact"),
    "",
    "## Character accuracy",
    "",
    table(groups, "character"),
    "",
    "## Outcome",
    "",
    verdict,
    "",
  ].join("\n");
}

const corpus = parseCorpus(readFileSync(required("corpus"), "utf8"));
const out = required("out");
mkdirSync(out, { recursive: true });

const libpinyinOutputs = convertWithLibpinyin(
  required("libpinyin-convert"),
  required("libpinyin-data"),
  mkdtempSync(join(tmpdir(), "libpinyin-")),
  corpus.map((entry) => entry.pinyin),
);

const session = await spawnRimeSession(
  required("rime-session"),
  required("rime-data"),
  mkdtempSync(join(tmpdir(), "rime-")),
  "rime_ice",
);
const rimeOutputs: string[] = [];
for (const entry of corpus) {
  rimeOutputs.push(await convertWithRime(session, entry.pinyin));
}
await session.close();

const conversions: Conversion[] = corpus.map((entry, index) => ({
  entry,
  libpinyin: normalise(libpinyinOutputs[index]!),
  rime: normalise(rimeOutputs[index]!),
}));
const summary = summarise(conversions);

writeFileSync(
  join(out, "conversions.tsv"),
  [
    "id\tsentence\tpinyin\tlibpinyin\trime\n",
    ...conversions.map(
      ({ entry, libpinyin, rime }) => `${entry.id}\t${entry.sentence}\t${entry.pinyin}\t${libpinyin}\t${rime}\n`,
    ),
  ].join(""),
);
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(join(out, "report.md"), render(summary, required("libpinyin-version"), required("rime-version")));
