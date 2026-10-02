// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Vitest's test runner for the node environment. Collecting the programs'
// test file lists the plan's programs under Node and builds the tasks from
// their listings, and each task keeps the time its program measured. Each
// group works in a directory of its own, which programs with the host's
// file system see as their working directory: a sequence shares one, every
// other program starts in an empty one.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestRunner, inject, type RunnerTask, type RunnerTestFile, type RunnerTestSuite } from "vitest";
import { applyReportedDuration, collectPrograms } from "../shared/collect.ts";
import { runNode } from "./run.ts";
import { parseTap } from "./tap.ts";

// The file Vitest collects, whose tasks this runner builds in its place.
const programsFile = /[\\/]programs\.test\.js$/;

export default class ProgramsRunner extends TestRunner {
  readonly #root = mkdtempSync(join(tmpdir(), "ibus-web-test-programs-"));
  #groups = 0;
  #cwd = join(this.#root, "listing");

  override importFile(filepath: string, source: "collect" | "setup"): unknown {
    if (source !== "collect" || !programsFile.test(filepath)) return super.importFile(filepath, source);
    const listing = join(this.#root, "listing");
    mkdirSync(listing, { recursive: true });
    const report = join(this.#root, "report.json");
    return collectPrograms("node", inject("testPrograms"), {
      startGroup: async () => {
        this.#cwd = join(this.#root, `group-${this.#groups++}`);
        mkdirSync(this.#cwd);
      },
      run: (program, args, timeoutMs, isListing) =>
        runNode(program, args, timeoutMs, isListing ? listing : this.#cwd, report),
      parseTap,
      print: ({ stream, text }) => (stream === "stdout" ? console.log(text) : console.error(text)),
    });
  }

  override onAfterRunTask(test: RunnerTask): void {
    super.onAfterRunTask(test);
    applyReportedDuration(test);
  }

  override async onAfterRunSuite(suite: RunnerTestSuite): Promise<void> {
    await super.onAfterRunSuite(suite);
    applyReportedDuration(suite);
  }

  override onAfterRunFiles(files: RunnerTestFile[]): void {
    super.onAfterRunFiles(files);
    rmSync(this.#root, { recursive: true, force: true });
  }
}
