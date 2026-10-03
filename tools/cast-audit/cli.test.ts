// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "cast-audit-test-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const findings = join(directory, "report.json");
writeFileSync(
  findings,
  JSON.stringify([{ file: "casts.c", function: "one", from: "void (*)(gpointer)", to: "GFunc" }]),
);

function compareFixture(name: string) {
  return spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("cast-audit.ts", import.meta.url)),
      "compare",
      findings,
      fileURLToPath(new URL(`fixtures/${name}.jsonc`, import.meta.url)),
    ],
    { encoding: "utf8" },
  );
}

test("CLI accepts JSONC allowances with comments and trailing commas", () => {
  const result = compareFixture("allow");
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("CLI rejects an unapproved cast with a useful finding", () => {
  const result = compareFixture("empty");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('unexpected: {"file":"casts.c","function":"one"');
});
