// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { compare, report } from "./cast-audit.ts";

const root = fileURLToPath(new URL("fixtures/", import.meta.url));
const sarif = readFileSync(new URL("fixtures/casts.sarif", import.meta.url), "utf8");
const expected = { file: "casts.c", function: "one", from: "void (*)(gpointer)", to: "GFunc" };

describe("cast audit", () => {
  test("reports an incompatible init cast, excluding G_CALLBACK and matching casts", () => {
    expect(report(sarif, root)).toEqual([{ ...expected, line: 12 }]);
  });
  test("accepts compiler stderr around the SARIF document", () => {
    expect(
      report(
        `emcc: warning: linker setting ignored\n${JSON.stringify(JSON.parse(sarif))}\n2 warnings generated.`,
        root,
      ),
    ).toHaveLength(1);
  });
  test("ignores an explicitly unrelated warning rule", () => {
    const input = JSON.parse(sarif);
    input.runs[0].results[0].ruleId = "-Wother";
    expect(report(JSON.stringify(input), root)).toEqual([]);
  });
  test("compares equal lists independently of order, lines, and reasons", () => {
    expect(compare([{ ...expected, line: 12 }], [{ ...expected, reason: "fixture", line: 90 }])).toEqual({
      missing: [],
      unexpected: [],
    });
  });
  test("reports an unapproved cast", () => {
    expect(compare([expected], [])).toEqual({ missing: [], unexpected: [expected] });
  });
  test("reports a stale allowance", () => {
    expect(compare([], [expected])).toEqual({ missing: [expected], unexpected: [] });
  });
  test("preserves duplicate casts as a multiset", () => {
    expect(compare([expected, expected], [expected])).toEqual({ missing: [], unexpected: [expected] });
  });
});

test("rejects malformed SARIF instead of producing a clean audit", () => {
  expect(() => report('{"version":"2.1.0","runs":', root)).toThrow();
});

test("resolves SARIF URI bases", () => {
  const input = JSON.parse(sarif);
  input.runs[0].originalUriBaseIds = { SOURCE: { uri: new URL("fixtures/", import.meta.url).href } };
  input.runs[0].results[0].locations[0].physicalLocation.artifactLocation = { uri: "casts.c", uriBaseId: "SOURCE" };
  expect(report(JSON.stringify(input), "/unrelated")).toEqual([
    { ...expected, file: expect.stringContaining("casts.c"), line: 12 },
  ]);
});
