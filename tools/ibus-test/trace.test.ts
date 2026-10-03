// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import { validateTrace } from "./trace.ts";

const valid = {
  version: 1,
  settings: [{ schema: "org.example.engine", key: "mode", value: "'한국어'" }],
  steps: [
    { op: "create", context: "first", engine: "example" },
    { op: "call", context: "first", method: "ProcessKeyEvent", args: "(uint32 65, uint32 38, uint32 0)" },
    { op: "wait", context: "first", event: "UpdatePreeditText", timeoutMs: 100 },
    { op: "destroy", context: "first" },
    { op: "create", context: "first", engine: "example" },
  ],
};

test("accepts typed settings and reuse after context destruction", () => {
  expect(validateTrace(valid)).toEqual(valid);
});

test.each([
  [
    "duplicate live context",
    [
      { op: "create", context: "a", engine: "e" },
      { op: "create", context: "a", engine: "e" },
    ],
  ],
  ["unknown call context", [{ op: "call", context: "a", method: "Reset", args: "()" }]],
  ["unknown wait context", [{ op: "wait", context: "a", event: "Done", timeoutMs: 1 }]],
  ["unknown destroy context", [{ op: "destroy", context: "a" }]],
  ["unknown operation", [{ op: "sleep", context: "a", timeoutMs: 1 }]],
])("rejects %s", (_name, steps) => {
  expect(() => validateTrace({ version: 1, settings: [], steps })).toThrow();
});

test.each([
  null,
  { version: 2, settings: [], steps: [] },
  { version: 1, settings: [{ schema: "s", key: "k", value: 4 }], steps: [] },
  { version: 1, settings: [], steps: [{ op: "create", context: "a", engine: "e", extra: true }] },
  { version: 1, settings: [], steps: [{ op: "create", context: "", engine: "e" }] },
  {
    version: 1,
    settings: [],
    steps: [
      { op: "create", context: "a", engine: "e" },
      { op: "wait", context: "a", event: "E", timeoutMs: 0 },
    ],
  },
])("rejects malformed trace %#", (input) => {
  expect(() => validateTrace(input)).toThrow();
});
