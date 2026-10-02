// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Reads what a program reported, and decides what went wrong with a run as
// a whole.

import type { Case, ParsedReport, ProgramRun, SuiteDuration } from "./protocol.ts";

// The parts of GoogleTest's JSON report read here. Times are strings such
// as "0.201s".
interface GtestReport {
  testsuites: {
    name: string;
    time?: string;
    testsuite: {
      name: string;
      status?: string;
      result?: string;
      time?: string;
      failures?: { failure: string }[];
    }[];
  }[];
}

const milliseconds = (time: string | undefined): number | undefined => {
  const seconds = time === undefined ? Number.NaN : Number.parseFloat(time);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
};

const withDuration = <T extends object>(value: T, durationMs: number | undefined): T & { durationMs?: number } =>
  durationMs === undefined ? value : { ...value, durationMs };

export const parseGtestJson = (text: string): ParsedReport => {
  let report: GtestReport;
  try {
    report = JSON.parse(text) as GtestReport;
  } catch (error) {
    return { cases: [], problem: `the report isn't JSON: ${String(error)}` };
  }
  if (!Array.isArray(report.testsuites)) return { cases: [], problem: "the report has no testsuites" };
  const cases: Case[] = [];
  const suites: SuiteDuration[] = [];
  for (const suite of report.testsuites) {
    const suiteMs = milliseconds(suite.time);
    if (suiteMs !== undefined) suites.push({ path: [suite.name], durationMs: suiteMs });
    for (const test of suite.testsuite) {
      const path = [suite.name, test.name];
      const durationMs = milliseconds(test.time);
      const failures = test.failures ?? [];
      if (failures.length > 0) {
        const message = failures.map(({ failure }) => failure).join("\n\n");
        cases.push(withDuration({ path, status: "failed", message }, durationMs));
      } else if (test.status === "NOTRUN" || test.result === "SKIPPED" || test.result === "SUPPRESSED") {
        cases.push({ path, status: "skipped" });
      } else {
        cases.push(withDuration({ path, status: "passed" }, durationMs));
      }
    }
  }
  return { cases, suites };
};

// A TAP test point's name as a path, and the message after it: g_test
// names its cases as paths, /suite/case, and puts a failure's message after
// the path. Any other name is a path of its own.
export const tapPath = (name: string): { path: string[]; message?: string } => {
  if (!name.startsWith("/")) return { path: [name] };
  const separator = name.indexOf(" - ");
  const path = (separator === -1 ? name : name.slice(0, separator)).split("/").filter((segment) => segment !== "");
  return separator === -1 ? { path } : { path, message: name.slice(separator + 3) };
};

// What a TAP program reported: its stdout.
export const tapText = (run: ProgramRun): string =>
  run.output
    .filter(({ stream }) => stream === "stdout")
    .map(({ text }) => `${text}\n`)
    .join("");

// What went wrong with a run that no failing case accounts for, if
// anything: it never exited, its report was broken or missing, or it
// exited with a failure while every case passed.
export const runProblem = (run: ProgramRun, report: ParsedReport | undefined): string | undefined => {
  const cases = report?.cases ?? [];
  const exit = run.exitCode === 0 ? undefined : `exited with ${run.exitCode}`;
  if (run.error !== undefined) return run.error;
  if (report?.problem !== undefined) return report.problem;
  if (cases.length === 0) return exit === undefined ? "no report" : `${exit}, with no report`;
  return cases.some(({ status }) => status === "failed") ? undefined : exit;
};
