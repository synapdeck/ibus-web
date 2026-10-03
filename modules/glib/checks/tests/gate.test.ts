// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The gate against Meson itself, on a small project whose tests collide in
// the ways the gate has to tell apart: the invocations it prints, run with
// `meson test`, run exactly the tests intended. Inputs Meson can't produce
// (names with whitespace) are written by hand.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { nodeTestData as data } from "@ibus-web/test-programs/node-tests";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// Two `x` tests, one without a suite (its only suite is the bare project),
// and three `y` tests, one of them in a suite the default setup excludes.
const MESON_BUILD = `
project('gate')
add_test_setup('default', is_default: true, exclude_suites: ['flaky'])
true_prog = find_program('true')
test('x', true_prog)
test('x', true_prog, suite: 'a')
test('y', true_prog, suite: 'b')
test('y', true_prog, suite: ['b', 'flaky'])
test('y', true_prog, suite: 'c')
`;

const scratch = mkdtempSync(join(tmpdir(), "gate-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const env = { ...process.env, PATH: `${data("path")}:${process.env["PATH"] ?? ""}` };

const meson = (cwd: string, ...args: string[]): string => execFileSync("meson", args, { cwd, env, encoding: "utf8" });

interface Baseline {
  mustPass?: string[];
  excluded?: string[];
}

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Runs the gate in dir, which holds its inputs but the baseline, written
// from baseline with every excluded test's reason "synthetic", or given as
// a path.
const gate = (dir: string, mode: string, baseline: Baseline | string, ...rest: string[]): Result => {
  let path = baseline;
  if (typeof path !== "string") {
    path = join(dir, "baseline.toml");
    const { mustPass = [], excluded = [] } = baseline as Baseline;
    const lines = ["[must_pass]", `tests = ${JSON.stringify(mustPass)}`, "[excluded]"];
    lines.push(...excluded.map((name) => `${JSON.stringify(name)} = "synthetic"`));
    writeFileSync(path, `${lines.join("\n")}\n`);
  }
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [data("gate"), mode, "meson-info/intro-tests.json", "default-tests", "excluded-suites", path, ...rest],
    { cwd: dir, encoding: "utf8" },
  );
  return { status, stdout, stderr };
};

let build: string;
let listed: string;
let suites: string;
let selections = 0;

// The log names of the tests `meson test` runs for each invocation.
const ran = (invocations: string): string[] => {
  const names: string[] = [];
  for (const line of invocations.split("\n").filter((line) => line !== "")) {
    const base = `selection-${selections++}`;
    meson(build, "test", "--no-rebuild", "--logbase", base, ...line.split(" "));
    const log = readFileSync(join(build, "meson-logs", `${base}.json`), "utf8");
    names.push(
      ...log
        .split("\n")
        .filter((entry) => entry.trim() !== "")
        .map((entry) => (JSON.parse(entry) as { name: string }).name),
    );
  }
  return names;
};

beforeAll(() => {
  const source = join(scratch, "source");
  build = join(scratch, "build");
  mkdirSync(source);
  writeFileSync(join(source, "meson.build"), MESON_BUILD);
  meson(scratch, "setup", build, source);
  listed = meson(build, "test", "--no-rebuild", "--list");
  writeFileSync(join(build, "default-tests"), listed);
  suites = meson(build, "runpython", data("setupExcludes"));
  writeFileSync(join(build, "excluded-suites"), suites);
});

describe("Meson", () => {
  test("names the suites the default setup excludes", () => {
    expect(suites.split(/\s+/).filter((s) => s !== "")).toEqual(["flaky"]);
  });

  test("lists the tests outside them", () => {
    expect(
      listed
        .split("\n")
        .filter((l) => l !== "")
        .sort(),
    ).toEqual(["a - gate:x", "b - gate:y", "c - gate:y", "gate:x"]);
  });

  // What the gate guards against.
  test("brings back a test the setup excludes when --suite selects it", () => {
    expect(ran("--suite gate:b gate:y").sort()).toEqual(["b - gate:y", "b+flaky - gate:y"]);
  });
});

describe("runnable", () => {
  // `a - gate:x` is told apart by its own suite, and `b - gate:y` by `b`,
  // which the excluded `b+flaky - gate:y` shares.
  let result: Result;
  beforeAll(() => {
    result = gate(build, "runnable", { excluded: ["gate:x", "c - gate:y"] });
  });

  test("succeeds", () => {
    expect([result.status, result.stderr]).toEqual([0, ""]);
  });

  test("has every invocation exclude the setup's suites", () => {
    const lines = result.stdout.split("\n").filter((line) => line !== "");
    expect(lines.map((line) => line.split(" ").slice(0, 2))).toEqual([
      ["--no-suite", "flaky"],
      ["--no-suite", "flaky"],
    ]);
  });

  test("runs every test but the excluded ones", () => {
    expect(ran(result.stdout).sort()).toEqual(["a - gate:x", "b - gate:y"]);
  });

  // The bare `gate:x` shares every suite but the bare project's, which
  // would select both `x` tests.
  test("refuses to narrow by a bare project suite", () => {
    const { status, stderr } = gate(build, "runnable", { excluded: ["a - gate:x"] });
    expect(status).toBe(1);
    expect(stderr).toContain("no suite tells gate:x apart");
  });

  test("reads the committed baseline", () => {
    const { status, stderr } = gate(build, "runnable", data("baseline"));
    expect([status, stderr]).toEqual([0, ""]);
  });

  test("refuses a test both must_pass and excluded", () => {
    const { status, stderr } = gate(build, "runnable", { mustPass: ["gate:x"], excluded: ["gate:x"] });
    expect(status).toBe(1);
    expect(stderr).toContain("gate: tests both must_pass and excluded: gate:x");
  });
});

// A log as Meson writes one, a JSON object a line.
const testlog = (name: string, results: Record<string, string>): string => {
  const path = join(build, name);
  const lines = Object.entries(results).map(([test, result]) => JSON.stringify({ name: test, result }));
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
};

describe("failing", () => {
  // A rerun of a failed must_pass test narrows as runnable does.
  let result: Result;
  beforeAll(() => {
    const log = testlog("failing-log.json", { "b - gate:y": "FAIL" });
    result = gate(build, "failing", { mustPass: ["b - gate:y"], excluded: ["c - gate:y"] }, log);
  });

  test("succeeds", () => {
    expect([result.status, result.stderr]).toEqual([0, ""]);
  });

  test("reruns the must_pass test that failed, alone", () => {
    expect(ran(result.stdout)).toEqual(["b - gate:y"]);
  });
});

describe("report", () => {
  const report = (results: Record<string, string>, rerun?: Record<string, string>): Result & { dir: string } => {
    const dir = mkdtempSync(join(scratch, "report-"));
    const log = testlog(`${dir.split("/").at(-1)}.json`, results);
    const rest = rerun === undefined ? [] : [testlog(`${dir.split("/").at(-1)}-rerun.json`, rerun)];
    return { dir, ...gate(build, "report", { mustPass: ["b - gate:y"], excluded: ["c - gate:y"] }, log, dir, ...rest) };
  };
  const read = (dir: string, name: string): string => readFileSync(join(dir, name), "utf8");

  test("passes when the must_pass tests pass, and writes the summary and a proposed baseline", () => {
    const { status, stdout, dir } = report({ "b - gate:y": "OK", "gate:x": "SKIP", "a - gate:x": "FAIL" });
    expect(status).toBe(0);
    const summary = [
      "4 tests, 3 run",
      "FAIL: 1",
      "OK: 1",
      "SKIP: 1",
      "must_pass: 1, failing: 0",
      "flaky: 0",
      "excluded, not run: 1",
      "  not run: c - gate:y (synthetic)",
      "",
    ].join("\n");
    expect(read(dir, "summary.txt")).toBe(summary);
    expect(stdout).toBe(summary);
    expect(read(dir, "proposed-baseline.toml")).toBe(
      [
        "# name = result, from this run",
        "[results]",
        '"a - gate:x" = "FAIL"',
        '"b - gate:y" = "OK"',
        '"gate:x" = "SKIP"',
        "",
      ].join("\n"),
    );
  });

  test("fails on a must_pass test that didn't pass", () => {
    const { status, dir } = report({ "b - gate:y": "FAIL" }, { "b - gate:y": "FAIL" });
    expect(status).toBe(1);
    expect(read(dir, "summary.txt")).toContain("  gating failure: b - gate:y (FAIL, FAIL alone)\n");
  });

  test("fails on a must_pass test that didn't run", () => {
    const { status, dir } = report({ "gate:x": "OK" });
    expect(status).toBe(1);
    expect(read(dir, "summary.txt")).toContain("  gating failure: b - gate:y (missing)\n");
  });

  // Under the parallel run's load, tests that assert wall-clock bounds miss
  // them.
  test("counts a must_pass test that passes alone as passed, and flaky", () => {
    const { status, dir } = report({ "b - gate:y": "TIMEOUT" }, { "b - gate:y": "OK" });
    expect(status).toBe(0);
    expect(read(dir, "summary.txt")).toContain(
      "flaky: 1\n  flaky: b - gate:y (TIMEOUT in the parallel run, OK alone)\n",
    );
  });
});

describe("whitespace", () => {
  // Inputs to the gate alone, in a directory of their own.
  const inputs = (tests: unknown[], list: string[], excludedSuites: string[]): string => {
    const dir = mkdtempSync(join(scratch, "inputs-"));
    mkdirSync(join(dir, "meson-info"));
    writeFileSync(join(dir, "meson-info", "intro-tests.json"), JSON.stringify(tests));
    writeFileSync(join(dir, "default-tests"), list.map((name) => `${name}\n`).join(""));
    writeFileSync(join(dir, "excluded-suites"), excludedSuites.map((suite) => `${suite}\n`).join(""));
    return dir;
  };

  // Meson accepts a test name with a space; a project name's spaces become
  // underscores in its suites, which the gate reads it from.
  test.each([
    { what: "a test name", entry: { name: "has space", suite: ["gate"] }, logName: "gate:has space" },
    { what: "a project name", entry: { name: "t", suite: ["my project:s"] }, logName: "s - my project:t" },
  ])("is refused in $what", ({ entry, logName }) => {
    const { status, stderr } = gate(inputs([entry], [logName], []), "runnable", {});
    expect(status).toBe(1);
    expect(stderr).toContain("contains whitespace");
  });

  test("is refused in an excluded suite", () => {
    const { status, stderr } = gate(inputs([], [], ["two words"]), "runnable", {});
    expect(status).toBe(1);
    expect(stderr).toContain("contains whitespace");
  });
});
