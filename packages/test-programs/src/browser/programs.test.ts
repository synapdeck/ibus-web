// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The plan's programs in the browser running this file. Programs share the
// origin's storage only within a sequence: it is cleared before each group
// starts.
//
// Browser mode runs every file with its own runner, a subclass of
// TestRunner, and takes no runner from the configuration, so the time each
// program reported replaces Vitest's own in TestRunner's hooks, which that
// subclass calls once it has recorded its own time.

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
