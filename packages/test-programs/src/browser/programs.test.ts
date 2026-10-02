// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The plan's programs in the browser running this file. Programs share the
// origin's storage only within a sequence: it is cleared before each group
// starts.
//
// Vitest 5's browser mode runs every file with a runner of its own, a
// subclass of TestRunner, and ignores test.runner, so the times programs
// reported replace Vitest's through TestRunner's own hooks instead. That
// relies on two things Vitest does: the subclass's onAfterRunTask calls
// TestRunner's, and the runner calls onAfterRunTask and onAfterRunSuite
// after it records its own time and before it sends the task's result on.
// Each program's "run" test fails if a time didn't come through.

import { TestRunner, inject, type RunnerTask, type RunnerTestSuite } from "vitest";
import { commands, server } from "vitest/browser";
import { applyReportedDuration, collectPrograms } from "../shared/collect.ts";
import type { Program, ProgramRun } from "../shared/protocol.ts";
import "./commands.ts";
import { clearStorage, runProgram } from "./run.ts";

const { onAfterRunTask, onAfterRunSuite } = TestRunner.prototype;
TestRunner.prototype.onAfterRunTask = function (this: TestRunner, test: RunnerTask): void {
  onAfterRunTask.call(this, test);
  applyReportedDuration(test);
};
TestRunner.prototype.onAfterRunSuite = async function (this: TestRunner, suite: RunnerTestSuite): Promise<void> {
  await onAfterRunSuite.call(this, suite);
  applyReportedDuration(suite);
};

const run = async (program: Program, args: readonly string[], timeoutMs: number): Promise<ProgramRun> => {
  // SharedArrayBuffer, and so every program with threads, needs it.
  if (!crossOriginIsolated) {
    return { output: [], exitCode: null, error: "the page is not cross-origin isolated", durationMs: 0 };
  }
  await commands.consoleBegin();
  const result = await runProgram(program, args, timeoutMs);
  result.output.push(...(await commands.consoleTake()));
  return result;
};

await collectPrograms(server.browser, inject("testPrograms"), {
  startGroup: clearStorage,
  run,
  parseTap: (text) => commands.parseTap(text),
  print: ({ stream, text }) => (stream === "stdout" ? console.log(text) : console.error(text)),
});
