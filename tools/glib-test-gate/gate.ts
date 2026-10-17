// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Compares a Meson test log with the committed baseline.
//
// Only tests listed under must_pass gate the build; excluded tests carry the
// reason they cannot run here and are never run, and every other result is
// reported but informational.
//
// TESTS is Meson's introspection file (meson-info/intro-tests.json), which
// gives each test's name and suites as data, where a log name is formatted
// text. LIST is the output of `meson test --no-rebuild --list`: the log names
// of the tests a plain `meson test` runs, after the default test setup's
// excluded suites. Only those count as the build's tests. SUITES names those
// excluded suites, one per line.
//
//   gate.ts runnable TESTS LIST SUITES BASELINE
//     print `meson test` invocations, one per line, that together run every
//     test not excluded
//   gate.ts failing TESTS LIST SUITES BASELINE TESTLOG
//     print invocations that rerun the must_pass tests that ran and did not
//     pass
//   gate.ts report TESTS LIST SUITES BASELINE TESTLOG OUT_DIR [RERUN]
//     write summary.txt and proposed-baseline.toml; fail on a gating failure
//
// A must_pass test that fails in the parallel run but passes in the rerun
// counts as passed and is reported as flaky: under the parallel run's load,
// tests that assert wall-clock bounds miss them.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { parse, stringify } from "smol-toml";

const PASSING: readonly (string | undefined)[] = ["OK", "EXPECTEDFAIL"];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// A file's lines, split at \n or \r\n; a final newline ends the last line
// rather than starting an empty one, and an empty file has none.
const lines = (text: string): string[] => (text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/));

interface Entry {
  name: string;
  result: string;
  stdout?: string;
}

const readEntries = (path: string): Entry[] =>
  lines(readFileSync(path, "utf8"))
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Entry);

const readLog = (path: string): Map<string, string> =>
  new Map(readEntries(path).map(({ name, result }) => [name, result]));

// Each test's output, which Meson's log holds whole.
const readOutputs = (path: string): Map<string, string> =>
  new Map(readEntries(path).map(({ name, stdout }) => [name, stdout ?? ""]));

// The last lines of a failure's output a build log shows, where the test's
// own messages say why it failed.
const OUTPUT_LINES = 40;

const splitSuite = (suite: string): [project: string, name: string] => {
  const colon = suite.indexOf(":");
  return colon === -1 ? [suite, ""] : [suite.slice(0, colon), suite.slice(colon + 1)];
};

interface Test {
  name: string;
  suites: string[];
  project: string;
  short: string;
  logName: string;
}

const testOf = (entry: { name: string; suite: string[] }): Test => {
  const project = splitSuite(entry.suite[0]!)[0];
  const short = `${project}:${entry.name}`;
  // Meson's log name: "<suite>+<suite> - <project>:<name>".
  const names = entry.suite.map((suite) => splitSuite(suite)[1]).filter((name) => name !== "");
  return {
    name: entry.name,
    suites: entry.suite,
    project,
    short,
    logName: names.length > 0 ? `${names.join("+")} - ${short}` : short,
  };
};

// The shell reads each invocation into words, so a space would split one
// argument into two.
const checkWord = (kind: string, value: string): void => {
  if (/\s/.test(value)) fail(`gate: ${kind} ${JSON.stringify(value)} contains whitespace`);
};

const readTests = (path: string, listPath: string): Map<string, Test> => {
  const entries = JSON.parse(readFileSync(path, "utf8")) as { name: string; suite: string[] }[];
  const tests = new Map(entries.map(testOf).map((test) => [test.logName, test]));
  const listed = lines(readFileSync(listPath, "utf8"));
  const unknown = listed.filter((name) => !tests.has(name));
  if (unknown.length > 0) fail(`gate: listed tests missing from the introspection file: ${unknown.join(", ")}`);
  for (const name of listed) {
    checkWord("test name", tests.get(name)!.name);
    checkWord("project name", tests.get(name)!.project);
  }
  return new Map(listed.map((name) => [name, tests.get(name)!]));
};

const readSuites = (path: string): string[] => {
  const suites = lines(readFileSync(path, "utf8")).filter((line) => line !== "");
  for (const suite of suites) checkWord("excluded suite", suite);
  return suites;
};

// meson test matches "<project>:<name>" arguments with fnmatch.
const pattern = (test: Test): string => {
  const escape = (s: string): string => s.replace(/([*?[])/g, "[$1]");
  return `${escape(test.project)}:${escape(test.name)}`;
};

// Argument lists for `meson test` that together run exactly targets.
//
// meson test selects by "<project>:<name>" alone, and some names repeat
// across suites. A name whose every holder is a target joins one shared
// invocation; any other target runs in its own, narrowed with --suite to a
// suite that none of the name's other holders is in. A bare project suite
// never narrows: --suite takes it to mean every test of the project.
//
// --suite also sets aside the default test setup's excluded suites, so every
// invocation excludes them itself with --no-suite.
const invocations = (targetList: Iterable<string>, tests: Map<string, Test>, excludedSuites: string[]): string[][] => {
  const targets = new Set(targetList);
  const holders = new Map<string, Test[]>();
  for (const test of tests.values()) holders.set(test.short, [...(holders.get(test.short) ?? []), test]);

  const shared: string[] = [];
  const alone: string[][] = [];
  const covered = new Set<string>();
  for (const logName of [...targets].sort()) {
    if (covered.has(logName)) continue;
    const test = tests.get(logName)!;
    const same = holders.get(test.short)!;
    const others = same.filter((t) => !targets.has(t.logName));
    if (others.length === 0) {
      shared.push(pattern(test));
      for (const t of same) covered.add(t.logName);
      continue;
    }
    const suite = test.suites.find((s) => s.includes(":") && others.every((o) => !o.suites.includes(s)));
    if (suite === undefined) return fail(`gate: no suite tells ${logName} apart from ${others[0]!.logName}`);
    alone.push(["--suite", suite, pattern(test)]);
    for (const t of same) if (t.suites.includes(suite)) covered.add(t.logName);
  }
  const noSuite = excludedSuites.flatMap((suite) => ["--no-suite", suite]);
  return [...(shared.length > 0 ? [shared] : []), ...alone].map((argv) => [...noSuite, ...argv]);
};

const printInvocations = (targets: Iterable<string>, tests: Map<string, Test>, excludedSuites: string[]): void => {
  for (const argv of invocations(targets, tests, excludedSuites)) console.log(argv.join(" "));
};

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const [mode, testsPath, listPath, suitesPath, baselinePath, ...rest] = process.argv.slice(2);
if (
  mode === undefined ||
  testsPath === undefined ||
  listPath === undefined ||
  suitesPath === undefined ||
  baselinePath === undefined
) {
  fail("usage: gate.ts runnable|failing|report TESTS LIST SUITES BASELINE [TESTLOG [OUT_DIR [RERUN]]]");
}
const tests = readTests(testsPath, listPath);
const excludedSuites = readSuites(suitesPath);

// must_pass.tests, the names that gate, and excluded, the reason each name
// there is never run.
const readBaseline = (path: string): { mustPass: string[]; excluded: Record<string, string> } => {
  let toml;
  try {
    toml = parse(readFileSync(path, "utf8"));
  } catch (e) {
    return fail(`gate: ${path}: ${(e as Error).message}`);
  }
  const table = (key: string): Record<string, unknown> => {
    const value = toml[key] ?? {};
    if (typeof value !== "object" || Array.isArray(value)) return fail(`gate: ${path}: ${key} must be a table`);
    return value as Record<string, unknown>;
  };
  const mustPass = table("must_pass")["tests"] ?? [];
  if (!Array.isArray(mustPass) || !mustPass.every((name) => typeof name === "string")) {
    return fail(`gate: ${path}: must_pass.tests must be an array of names`);
  }
  const excluded: Record<string, string> = {};
  for (const [name, reason] of Object.entries(table("excluded"))) {
    if (typeof reason !== "string") return fail(`gate: ${path}: the reason ${name} is excluded must be a string`);
    excluded[name] = reason;
  }
  return { mustPass, excluded };
};
const { mustPass, excluded } = readBaseline(baselinePath);

const overlap = mustPass.filter((name) => Object.hasOwn(excluded, name)).sort();
if (overlap.length > 0) fail(`gate: tests both must_pass and excluded: ${overlap.join(", ")}`);

if (mode === "runnable") {
  printInvocations(
    [...tests.keys()].filter((name) => !Object.hasOwn(excluded, name)),
    tests,
    excludedSuites,
  );
  process.exit(0);
}

const results = readLog(rest[0] ?? fail(`gate: ${mode} takes TESTLOG`));
const failing = mustPass.filter((name) => !PASSING.includes(results.get(name)));

if (mode === "failing") {
  // A must_pass test missing from the run (renamed, or the run broke) is
  // not rerun; the report counts it as missing.
  printInvocations(
    failing.filter((name) => results.has(name) && tests.has(name)),
    tests,
    excludedSuites,
  );
  process.exit(0);
}

if (mode !== "report") fail(`gate: no mode ${mode}`);
const outDir = rest[1] ?? fail("gate: report takes OUT_DIR");
const rerun = rest[2] === undefined ? new Map<string, string>() : readLog(rest[2]);
const outputs = new Map([...readOutputs(rest[0]!), ...(rest[2] === undefined ? [] : readOutputs(rest[2]))]);
const flaky = failing.filter((name) => PASSING.includes(rerun.get(name)));
const failures = failing.filter((name) => !flaky.includes(name));

const byResult = new Map<string, string[]>();
for (const [name, result] of results) byResult.set(result, [...(byResult.get(result) ?? []), name]);

const summary = [`${tests.size} tests, ${results.size} run`];
for (const [result, names] of [...byResult].sort(([a], [b]) => compare(a, b)))
  summary.push(`${result}: ${names.length}`);
summary.push(`must_pass: ${mustPass.length}, failing: ${failures.length}`);
summary.push(`flaky: ${flaky.length}`);
for (const name of flaky) {
  summary.push(`  flaky: ${name} (${results.get(name) ?? "missing"} in the parallel run, ${rerun.get(name)} alone)`);
}
for (const name of failures) {
  const alone = rerun.has(name) ? `, ${rerun.get(name)} alone` : "";
  summary.push(`  gating failure: ${name} (${results.get(name) ?? "missing"}${alone})`);
}
summary.push(`excluded, not run: ${Object.keys(excluded).length}`);
for (const [name, reason] of Object.entries(excluded).sort(([a], [b]) => compare(a, b))) {
  summary.push(`  not run: ${name} (${reason})`);
}
for (const name of Object.keys(excluded)) {
  if (!tests.has(name)) summary.push(`  warning: excluded test not in the build: ${name}`);
}
writeFileSync(join(outDir, "summary.txt"), `${summary.join("\n")}\n`);

const proposed = stringify({ results: Object.fromEntries([...results].sort(([a], [b]) => compare(a, b))) });
writeFileSync(join(outDir, "proposed-baseline.toml"), `# name = result, from this run\n${proposed}`);

console.log(summary.join("\n"));
for (const name of failures) {
  const output = lines(outputs.get(name) ?? "");
  if (output.length === 0) continue;
  console.log(`\noutput of ${name}, its last ${Math.min(output.length, OUTPUT_LINES)} lines:`);
  console.log(output.slice(-OUTPUT_LINES).join("\n"));
}
process.exit(failures.length > 0 ? 1 : 0);
