// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Turns a plan's programs into Vitest's tasks for one environment. While
// Vitest collects, each program lists its cases (GoogleTest's
// --gtest_list_tests, g_test's -l), which become a suite for the program
// holding its own suites and cases. When Vitest runs that suite, the
// program runs once, restricted to the cases Vitest selected
// (--gtest_filter, or g_test's -s for the others), and each case's test
// replays what the program reported for it, with the time the program
// measured. The program's suite ends with a test named "run", which fails
// when the run went wrong as a whole: its listing failed, it never exited,
// its report was broken, it ran cases it wasn't asked to, it exited with a
// failure no failing case explains, or it wasn't run because an earlier
// program of its sequence failed.

import { beforeAll, describe, test, type RunnerTask, type RunnerTestSuite } from "vitest";
import type { Case, OutputLine, ParsedReport, Plan, Program, ProgramRun } from "./protocol.ts";
import { parseGtestJson, runProblem, tapPath, tapText } from "./report.ts";

// How an environment runs programs.
export interface Environment {
  // Called before each group's first program runs: a fresh storage context.
  startGroup(): Promise<void>;
  // Runs a program with arguments after its own. A listing runs outside
  // any group's storage.
  run(program: Program, args: readonly string[], timeoutMs: number, listing: boolean): Promise<ProgramRun>;
  parseTap(text: string): Promise<ParsedReport>;
  // Logs lines of a program's output, from one stream, from inside a test.
  print(lines: OutputLine): void;
}

const RUN_TEST = "run";

const keyOf = (path: readonly string[]): string => JSON.stringify(path);

const describeError = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

const parse = async (
  program: Program,
  run: ProgramRun,
  environment: Environment,
): Promise<ParsedReport | undefined> => {
  switch (program.format) {
    case "tap":
      return environment.parseTap(tapText(run));
    case "gtest-json":
      return run.report === undefined ? undefined : parseGtestJson(run.report.text);
    case "exit-status":
      if (run.exitCode === null) return undefined;
      return {
        cases: [
          {
            path: ["exit status"],
            status: run.exitCode === 0 ? "passed" : "failed",
            message: `exited with ${run.exitCode}`,
          },
        ],
      };
  }
};

type Listing = { paths: string[][] } | { problem: string; output: readonly OutputLine[] };

const list = async (program: Program, environment: Environment, timeoutMs: number): Promise<Listing> => {
  if (program.format === "exit-status") return { paths: [["exit status"]] };
  const args = program.format === "gtest-json" ? ["--gtest_list_tests"] : ["-l"];
  let run: ProgramRun;
  try {
    run = await environment.run(program, args, timeoutMs, true);
  } catch (error) {
    return { problem: `listing failed: ${describeError(error)}`, output: [] };
  }
  const failed = (why: string): Listing => ({ problem: `listing failed: ${why}`, output: run.output });
  if (run.error !== undefined) return failed(run.error);
  if (run.exitCode !== 0) return failed(`exited with ${run.exitCode}`);
  let paths: string[][];
  if (program.format === "gtest-json") {
    if (run.report === undefined) return failed("no report");
    const report = parseGtestJson(run.report.text);
    if (report.problem !== undefined) return failed(report.problem);
    paths = report.cases.map(({ path }) => path);
  } else {
    // g_test lists one path a line, as a TAP comment when it reports in
    // TAP.
    paths = run.output
      .filter(({ stream }) => stream === "stdout")
      .map(({ text }) => /^(?:# )?(\/.*)$/.exec(text)?.[1])
      .filter((path) => path !== undefined)
      .map((path) => tapPath(path).path);
  }
  return paths.length === 0 ? failed("no cases") : { paths };
};

// The arguments that restrict a run to the selected cases. g_test's -p
// would select them, but g_test then ends each -p's tests with a TAP plan
// of its own, and a stream with several plans is broken; its -s instead
// skips the others, each by its exact path, which it reports as skipped.
// g_test stops at its first failing case unless it is told to keep going,
// as GoogleTest does.
const selectionArgs = (program: Program, selected: readonly string[][], unselected: readonly string[][]): string[] => {
  switch (program.format) {
    case "gtest-json":
      return [`--gtest_filter=${selected.map((path) => path.join(".")).join(":")}`];
    case "tap":
      return ["--keep-going", ...unselected.flatMap((path) => ["-s", `/${path.join("/")}`])];
    case "exit-status":
      return [];
  }
};

// A suite's or case's place among its siblings, in the order the listing
// first names it.
type Node = { kind: "case"; path: string[] } | { kind: "suite"; name: string; children: Node[] };

const treeOf = (paths: readonly string[][]): Node[] => {
  const root: Node[] = [];
  const suites = new Map<string, Node[]>();
  for (const path of paths) {
    let children = root;
    for (const [depth, name] of path.slice(0, -1).entries()) {
      const key = keyOf(path.slice(0, depth + 1));
      let next = suites.get(key);
      if (next === undefined) {
        next = [];
        suites.set(key, next);
        children.push({ kind: "suite", name, children: next });
      }
      children = next;
    }
    children.push({ kind: "case", path });
  }
  return root;
};

// What one program's run left for its tests.
interface Outcome {
  // The program wasn't run at all, and why.
  notRun?: string;
  output: readonly OutputLine[];
  cases: Map<string, Case>;
  problem?: string;
}

// A sequence's programs with their listed cases, the storage they share,
// how many of them have run, in order, and whether one failed.
interface Group {
  members: { program: Program; paths: string[][] }[];
  started: boolean;
  ran: number;
  failed?: string;
}

// Runs a sequence's programs before `upTo` that haven't run, in full, for
// the storage they leave to it: when Vitest selects only later programs,
// those still see what the earlier ones stored.
const catchUp = async (group: Group, upTo: number, environment: Environment, timeoutMs: number): Promise<void> => {
  for (; group.ran < upTo && group.failed === undefined; group.ran++) {
    const { program, paths } = group.members[group.ran]!;
    if (paths.length === 0) {
      group.failed = `${program.name} failed to list its cases`;
      break;
    }
    const run = await environment.run(program, selectionArgs(program, paths, []), timeoutMs, false);
    const report = await parse(program, run, environment);
    if (runProblem(run, report) !== undefined || report?.cases.some(({ status }) => status === "failed"))
      group.failed = `${program.name} failed, run for the storage it leaves`;
  }
};

// Each test of a program's suite under the path of the case it replays.
const testsOf = (suite: RunnerTestSuite, prefix: readonly string[], into: Map<string, RunnerTask>): void => {
  for (const task of suite.tasks) {
    if (task.type === "suite") testsOf(task, [...prefix, task.name], into);
    else into.set(keyOf([...prefix, task.name]), task);
  }
};

const suitesOf = (suite: RunnerTestSuite, prefix: readonly string[], into: Map<string, RunnerTask>): void => {
  for (const task of suite.tasks) {
    if (task.type !== "suite") continue;
    const path = [...prefix, task.name];
    into.set(keyOf(path), task);
    suitesOf(task, path, into);
  }
};

// The tasks under a program's suite, finished by now, whose result doesn't
// carry the time the program reported for them: replacing Vitest's time
// relies on hooks Vitest runs after it records its own, and this makes a
// change there fail rather than go unnoticed.
const timesNotApplied = (suite: RunnerTestSuite, self: RunnerTask, prefix: readonly string[] = []): string[] =>
  suite.tasks.flatMap((task) => {
    if (task === self) return [];
    const path = [...prefix, task.name];
    const reported = task.meta.testProgramDurationMs;
    const own =
      reported !== undefined && task.result?.duration !== undefined && task.result.duration !== reported
        ? [path.join(" › ")]
        : [];
    return task.type === "suite" ? [...own, ...timesNotApplied(task, self, path)] : own;
  });

const setDuration = (task: RunnerTask | undefined, durationMs: number | undefined): void => {
  if (task !== undefined && durationMs !== undefined) task.meta.testProgramDurationMs = durationMs;
};

const runProgram = async (
  program: Program,
  suite: RunnerTestSuite,
  group: Group,
  environment: Environment,
  timeoutMs: number,
): Promise<Outcome> => {
  const tests = new Map<string, RunnerTask>();
  testsOf(suite, [], tests);
  // The suite's own last test, not a case.
  tests.delete(keyOf([RUN_TEST]));
  const isSelected = (task: RunnerTask): boolean => task.mode === "run" || task.mode === "queued";
  const pathsWhere = (wanted: boolean): string[][] =>
    [...tests].filter(([, task]) => isSelected(task) === wanted).map(([key]) => JSON.parse(key) as string[]);
  const selected = pathsWhere(true);
  const unselected = pathsWhere(false);
  const outcome: Outcome = { output: [], cases: new Map() };
  if (group.failed !== undefined) return { ...outcome, notRun: group.failed };
  if (selected.length === 0) return outcome;
  const index = group.members.findIndex((member) => member.program === program);
  try {
    if (!group.started) {
      group.started = true;
      await environment.startGroup();
    }
    await catchUp(group, index, environment, timeoutMs);
    if (group.failed !== undefined) return { ...outcome, notRun: group.failed };
    group.ran = index + 1;
    const run = await environment.run(program, selectionArgs(program, selected, unselected), timeoutMs, false);
    const report = await parse(program, run, environment);
    outcome.output = run.output;
    for (const entry of report?.cases ?? []) outcome.cases.set(keyOf(entry.path), entry);
    const selectedKeys = new Set(selected.map(keyOf));
    const extra = [...outcome.cases]
      .filter(([key, { status }]) => !selectedKeys.has(key) && status !== "skipped")
      .map(([, { path }]) => path.join(" › "));
    const problem =
      runProblem(run, report) ??
      (extra.length === 0 ? undefined : `ran cases it wasn't asked to run: ${extra.join(", ")}`);
    if (problem !== undefined) outcome.problem = problem;

    setDuration(suite, run.durationMs);
    setDuration(
      suite.tasks.find(({ type, name }) => type === "test" && name === RUN_TEST),
      run.durationMs,
    );
    for (const [key, entry] of outcome.cases) setDuration(tests.get(key), entry.durationMs);
    const suites = new Map<string, RunnerTask>();
    suitesOf(suite, [], suites);
    for (const { path, durationMs } of report?.suites ?? []) setDuration(suites.get(keyOf(path)), durationMs);
  } catch (error) {
    outcome.problem = describeError(error);
  }
  const failed =
    outcome.problem !== undefined ||
    selected.some((path) => {
      const status = outcome.cases.get(keyOf(path))?.status;
      return status === undefined || status === "failed";
    });
  if (failed) group.failed = `${program.name} failed`;
  return outcome;
};

// Each stretch of lines from one stream as one log entry: Vitest heads
// every entry with the test's name.
const printAll = (environment: Environment, output: readonly OutputLine[]): void => {
  let stretch: OutputLine | undefined;
  for (const line of output) {
    if (stretch?.stream === line.stream) {
      stretch.text += `\n${line.text}`;
      continue;
    }
    if (stretch !== undefined) environment.print(stretch);
    stretch = { ...line };
  }
  if (stretch !== undefined) environment.print(stretch);
};

const declareCases = (nodes: readonly Node[], outcome: () => Outcome, environment: Environment): void => {
  for (const node of nodes) {
    if (node.kind === "suite") {
      describe(node.name, () => declareCases(node.children, outcome, environment));
      continue;
    }
    const key = keyOf(node.path);
    test(node.path.at(-1) ?? "", (context) => {
      const { notRun, output, cases, problem } = outcome();
      if (notRun !== undefined) context.skip(`not run: ${notRun}`);
      printAll(environment, output);
      const entry = cases.get(key);
      if (entry === undefined) throw new Error(`not reported${problem === undefined ? "" : `: ${problem}`}`);
      if (entry.status === "skipped") context.skip(entry.message);
      if (entry.status === "failed") throw new Error(entry.message ?? "failed");
    });
  }
};

const declareProgram = (
  program: Program,
  listing: Listing,
  group: Group,
  environment: Environment,
  timeoutMs: number,
): void => {
  describe(program.name, () => {
    if ("problem" in listing) {
      const { problem, output } = listing;
      test(RUN_TEST, () => {
        printAll(environment, output);
        throw new Error(problem);
      });
      return;
    }
    let outcome: Outcome = { output: [], cases: new Map() };
    // Vitest reads the first parameter's pattern for the fixtures it asks
    // for; the suite comes second.
    // oxlint-disable-next-line no-empty-pattern
    beforeAll(async ({}, suite) => {
      outcome = await runProgram(program, suite as RunnerTestSuite, group, environment, timeoutMs);
    });
    declareCases(treeOf(listing.paths), () => outcome, environment);
    test(RUN_TEST, (context) => {
      const { notRun, output, problem } = outcome;
      if (notRun !== undefined) throw new Error(`not run: ${notRun}`);
      if (problem !== undefined) {
        printAll(environment, output);
        throw new Error(problem);
      }
      const suite = context.task.suite;
      const unapplied = suite === undefined ? [] : timesNotApplied(suite, context.task);
      if (unapplied.length > 0)
        throw new Error(`Vitest's own times stand in for the program's for ${unapplied.join(", ")}`);
    });
  });
};

// Lists every program of the plan and declares its tasks, under a suite
// named after the environment, which is how results from different
// environments tell themselves apart.
export const collectPrograms = async (name: string, plan: Plan, environment: Environment): Promise<void> => {
  const listings: { program: Program; listing: Listing; group: Group }[] = [];
  for (const programs of plan.groups) {
    const group: Group = { members: [], started: false, ran: 0 };
    for (const program of programs) {
      const listing = await list(program, environment, plan.timeoutMs);
      group.members.push({ program, paths: "paths" in listing ? listing.paths : [] });
      listings.push({ program, listing, group });
    }
  }
  describe(name, () => {
    for (const { program, listing, group } of listings)
      declareProgram(program, listing, group, environment, plan.timeoutMs);
  });
};

// Replaces the time Vitest measured for a task, replaying it, with the
// time the program measured, once Vitest has recorded its own.
export const applyReportedDuration = (task: RunnerTask): void => {
  const durationMs = task.meta.testProgramDurationMs;
  if (durationMs !== undefined && task.result !== undefined) task.result.duration = durationMs;
};
