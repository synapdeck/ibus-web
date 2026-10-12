// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Runs a program under Node: `node NAME.js ARGS...` in a working directory
// that stands for its storage, with IBUS_WEB_TEST_REPORT naming the file a
// GoogleTest program writes its report to, and TMPDIR a directory the
// caller removes, which a program that dies leaves its files in.

import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import type { OutputLine, Program, ProgramRun } from "../shared/protocol.ts";

export const runNode = async (
  program: Program,
  args: readonly string[],
  timeoutMs: number,
  cwd: string,
  reportPath: string,
  tmpDir: string,
): Promise<ProgramRun> => {
  await rm(reportPath, { force: true });
  const output: OutputLine[] = [];
  const start = performance.now();
  const child = spawn(process.execPath, [join(program.dir, `${program.name}.js`), ...program.args, ...args], {
    cwd,
    env: { ...process.env, IBUS_WEB_TEST_REPORT: reportPath, TMPDIR: tmpDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = (stream: NodeJS.ReadableStream, name: OutputLine["stream"]) =>
    new Promise<void>((resolve) => {
      const reader = createInterface({ input: stream, crlfDelay: Infinity });
      reader.on("line", (text) => output.push({ stream: name, text }));
      reader.on("close", resolve);
    });
  const streams = Promise.all([lines(child.stdout, "stdout"), lines(child.stderr, "stderr")]);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | Error>((resolve) => {
    child.once("error", resolve);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  const durationMs = performance.now() - start;
  // The program's pthreads can hold its pipes open past its exit.
  await Promise.race([streams, new Promise((resolve) => setTimeout(resolve, 1000))]);

  let report: string | undefined;
  try {
    report = await readFile(reportPath, "utf8");
  } catch {
    report = undefined;
  }
  const run: ProgramRun = { output, exitCode: null, durationMs };
  if (report !== undefined) run.report = { format: "gtest-json", text: report };
  if (ended instanceof Error) run.error = `couldn't start: ${ended.message}`;
  else if (timedOut) run.error = `no exit in ${timeoutMs} ms`;
  else if (ended.code === null) run.error = `killed by ${ended.signal}`;
  else run.exitCode = ended.code;
  return run;
};
