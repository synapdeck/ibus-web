// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import { compareTranscripts } from "./compare.ts";
import { checkCoverage, validateCoverage } from "./coverage.ts";
import type { ScenarioCoverage } from "./coverage.ts";
import type { TranscriptRecord } from "./types.ts";

const records: TranscriptRecord[] = [
  { kind: "reply", step: 0, value: null },
  { kind: "event", step: 1, context: "a", name: "CommitText", payload: { signature: "(v)", text: "('한',)" } },
  {
    kind: "event",
    step: 1,
    context: "a",
    name: "ForwardKeyEvent",
    payload: { signature: "(uuu)", text: "(32, 57, 0)" },
  },
  { kind: "reply", step: 1, value: true },
];

const coverage: ScenarioCoverage = {
  scenario: "forwarding",
  required: [
    { kind: "event", step: 1, name: "CommitText", signature: "(v)", payloadContains: "'한'" },
    { kind: "event", step: 1, name: "ForwardKeyEvent", signature: "(uuu)", payloadContains: "32, 57" },
    { kind: "reply", step: 1, value: true },
  ],
  forbidden: [{ kind: "event", step: 1, name: "DeleteSurroundingText" }],
};

test("requires observed event content, order, replies, and absence", () => {
  expect(() => checkCoverage(records, coverage)).not.toThrow();
  expect(compareTranscripts([], [])).toEqual([]);
  expect(() => checkCoverage([], coverage)).toThrow(/missing ordered/);
  expect(() =>
    checkCoverage(
      records.filter((record) => record.kind !== "event"),
      coverage,
    ),
  ).toThrow(/missing/);
  expect(() => checkCoverage([records[0]!, records[2]!, records[1]!, records[3]!], coverage)).toThrow(/missing/);
  expect(() =>
    checkCoverage(
      [
        ...records,
        {
          kind: "event",
          step: 1,
          context: "a",
          name: "DeleteSurroundingText",
          payload: { signature: "()", text: "()" },
        },
      ],
      coverage,
    ),
  ).toThrow(/forbidden/);
});

test("rejects missing, unknown, duplicate, and empty scenario coverage", () => {
  const valid = { version: 1, scenarios: [coverage] };
  expect(validateCoverage(valid, ["forwarding"])).toEqual(new Map([["forwarding", coverage]]));
  expect(() => validateCoverage(valid, ["forwarding", "composition"])).toThrow(/missing/);
  expect(() => validateCoverage(valid, ["composition"])).toThrow(/unknown/);
  expect(() => validateCoverage({ version: 1, scenarios: [coverage, coverage] }, ["forwarding"])).toThrow(/duplicate/);
  expect(() => validateCoverage({ version: 1, scenarios: [{ ...coverage, required: [] }] }, ["forwarding"])).toThrow(
    /nonempty/,
  );
});
