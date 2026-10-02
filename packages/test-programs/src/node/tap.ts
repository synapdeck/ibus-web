// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Reads a TAP program's stdout: one case per test point, nested in its
// subtests and, for a test point named as a path, by the path's segments.
// tap-parser is a Node library, so browsers reach this through a command.

import { Parser, type FinalResults, type Result } from "tap-parser";
import type { Case, ParsedReport } from "../shared/protocol.ts";
import { tapPath } from "../shared/report.ts";

// g_test gives a test's time only for slow ones, as a comment after it.
const SLOW_TEST = /^# slow test (\S+) executed in ([0-9.]+) secs$/;

const toCase = (prefix: readonly string[], result: Result): Case => {
  const { path, message } = tapPath(result.name || `test ${result.id}`);
  const entry: Case = { path: [...prefix, ...path], status: "passed" };
  // tap-parser reads a test point's `# time=` directive into milliseconds.
  if (result.time !== null) entry.durationMs = result.time;
  if (result.skip !== false || result.todo !== false) return { path: entry.path, status: "skipped" };
  if (result.ok) return entry;
  const diag: unknown = result.diag;
  entry.status = "failed";
  entry.message =
    diag !== null && diag !== undefined
      ? JSON.stringify(diag, null, 2)
      : (message ?? `not ok ${result.id} ${result.name}`);
  return entry;
};

// Collects a parser's test points, and its subtests' under their names. A
// subtest ends with a test point of its own that sums it up, which isn't a
// case of its own.
const listen = (parser: Parser, prefix: readonly string[], cases: Case[]): void => {
  const subtests = new Set<string>();
  parser.on("child", (child: Parser) => {
    subtests.add(child.name);
    listen(child, [...prefix, child.name], cases);
  });
  parser.on("assert", (result: Result) => {
    if (subtests.has(result.name)) return;
    cases.push(toCase(prefix, result));
  });
  parser.on("comment", (line: string) => {
    const slow = SLOW_TEST.exec(line.trim());
    if (slow === null) return;
    const path = [...prefix, ...tapPath(slow[1]!).path];
    const entry = cases.findLast((candidate) => candidate.path.join("/") === path.join("/"));
    if (entry !== undefined) entry.durationMs = Number(slow[2]) * 1000;
  });
};

export const parseTap = (text: string): Promise<ParsedReport> =>
  new Promise((resolve) => {
    const cases: Case[] = [];
    const parser = new Parser((results: FinalResults) => {
      // What broke the protocol itself, failing test points aside: no
      // plan, a plan it didn't meet, a bail out.
      const reasons = results.failures.flatMap(({ tapError }) => (typeof tapError === "string" ? [tapError] : []));
      if (results.bailout !== false)
        reasons.push(`bailed out${results.bailout === true ? "" : `: ${results.bailout}`}`);
      resolve(reasons.length === 0 ? { cases } : { cases, problem: `the TAP stream is broken: ${reasons.join("; ")}` });
    });
    listen(parser, [], cases);
    parser.end(text);
  });
