// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { compare, report } from "./cast-audit.ts";

const root = fileURLToPath(new URL("fixtures/", import.meta.url));
const sarif = readFileSync(new URL("fixtures/casts.sarif", import.meta.url), "utf8");
const direct = { file: "casts.c", function: "takes_int", from: "void (*)(int)", to: "void (*)(void)", line: 23 };
const expected = { file: "casts.c", function: "one", from: "void (*)(gpointer)", to: "GFunc" };

describe("cast audit", () => {
  test("reports an incompatible init cast, excluding G_CALLBACK and matching casts", () => {
    expect(report(sarif, root)).toEqual([{ ...expected, line: 12 }, direct]);
  });
  test("accepts compiler stderr around the SARIF document", () => {
    expect(
      report(
        `emcc: warning: linker setting ignored\n${JSON.stringify(JSON.parse(sarif))}\n2 warnings generated.`,
        root,
      ),
    ).toHaveLength(2);
  });
  test("ignores an explicitly unrelated warning rule", () => {
    const input = JSON.parse(sarif);
    input.runs[0].results[0].ruleId = "-Wother";
    expect(report(JSON.stringify(input), root)).toEqual([direct]);
  });
  test("rejects the compiled direct zero-argument call with an empty allowance", () => {
    const findings = report(sarif, root).filter((cast) => cast.function === "takes_int");
    expect(findings).toEqual([direct]);
    expect(compare(findings, [])).toEqual({ missing: [], unexpected: [direct] });
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
  for (const result of input.runs[0].results) {
    result.locations[0].physicalLocation.artifactLocation = { uri: "casts.c", uriBaseId: "SOURCE" };
  }
  expect(report(JSON.stringify(input), "/unrelated")).toEqual([
    { ...expected, file: expect.stringContaining("casts.c"), line: 12 },
    { ...direct, file: expect.stringContaining("casts.c") },
  ]);
});
