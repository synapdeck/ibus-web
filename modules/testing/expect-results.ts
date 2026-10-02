// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Fails unless Vitest's JSON report holds exactly the expected tests, each
// at its expected place with its expected result:
//
//   expect-results.ts <results.json> <expected.json>
//
// where expected.json is
//
//   { ENVIRONMENT: [{ "path": [PROGRAM, SUITE..., TEST],
//                     "status": "passed" | "failed" | "skipped",
//                     "durationMs": [MIN, MAX] }, ...] }
//
// with durationMs optional, and each test sits under a suite named after
// its environment.

import { readFileSync } from "node:fs";

const [resultsPath, expectedPath] = process.argv.slice(2);
if (resultsPath === undefined || expectedPath === undefined) {
  console.error("usage: expect-results.ts <results.json> <expected.json>");
  process.exit(1);
}

interface Results {
  testResults: {
    assertionResults: { ancestorTitles: string[]; title: string; status: string; duration?: number | null }[];
  }[];
}

interface Expected {
  path: string[];
  status: string;
  durationMs?: [number, number];
}

const results = JSON.parse(readFileSync(resultsPath, "utf8")) as Results;
const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as Record<string, Expected[]>;

// Vitest's JSON report calls a skipped test "pending".
const statusOf = (vitest: string): string => (vitest === "pending" ? "skipped" : vitest);

const keyOf = (environment: string, path: readonly string[]): string => [environment, ...path].join(" › ");

const actual = new Map<string, { status: string; duration: number | undefined }>();
for (const file of results.testResults) {
  for (const { ancestorTitles, title, status, duration } of file.assertionResults) {
    actual.set(keyOf(ancestorTitles[0] ?? "", [...ancestorTitles.slice(1), title]), {
      status: statusOf(status),
      duration: duration ?? undefined,
    });
  }
}

const problems: string[] = [];
let count = 0;
for (const [environment, tests] of Object.entries(expected)) {
  for (const { path, status, durationMs } of tests) {
    count++;
    const key = keyOf(environment, path);
    const got = actual.get(key);
    actual.delete(key);
    if (got === undefined) {
      problems.push(`missing: ${key} (expected ${status})`);
      continue;
    }
    if (got.status !== status) problems.push(`${key}: ${got.status}, expected ${status}`);
    if (durationMs !== undefined) {
      const [min, max] = durationMs;
      if (got.duration === undefined || got.duration < min || got.duration > max)
        problems.push(`${key}: took ${got.duration} ms, expected ${min} to ${max}`);
    }
  }
}
for (const [key, { status }] of actual) problems.push(`unexpected: ${key} (${status})`);

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(`each of the ${count} tests has its expected place and result`);
