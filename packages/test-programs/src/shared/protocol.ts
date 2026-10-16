// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What Vitest's configuration hands the test files, and what a browser test
// file and a program's Worker pass each other.

// How a program reports its cases: GoogleTest's JSON report, which it hands
// over itself, or TAP on its stdout.
export type Format = "gtest-json" | "tap";

export interface Program {
  name: string;
  format: Format;
  // The directory holding NAME.js.
  dir: string;
  // NAME.js's path on the browsers' server.
  url: string;
  args: string[];
}

// Programs grouped by the storage they share, in the order they run: a group
// is one program on its own, or a sequence PREFIX.1, PREFIX.2, ... that
// shares its storage.
export interface Plan {
  timeoutMs: number;
  groups: Program[][];
}

declare module "vitest" {
  export interface ProvidedContext {
    testPrograms: Plan;
    nodeTestData: Record<string, string>;
  }
  export interface TaskMeta {
    // The time a program measured for a case or suite, or the time the
    // shim measured for a whole program, which stands in for the time
    // Vitest measures replaying it.
    testProgramDurationMs?: number;
  }
}

export interface OutputLine {
  stream: "stdout" | "stderr" | "console";
  text: string;
}

export interface Report {
  format: Format;
  text: string;
}

// How a run ended. exitCode is null when the program never exited, and
// error then says why. report is the last one the program handed over.
// durationMs is the wall time from its start to its end.
export interface ProgramRun {
  output: OutputLine[];
  exitCode: number | null;
  error?: string;
  report?: Report;
  durationMs: number;
}

// A browser test file's one message to a program's Worker.
export interface StartMessage {
  // Absolute: the Worker resolves it against its own script's URL otherwise.
  url: string;
  args: string[];
}

export type WorkerMessage =
  | { kind: "output"; line: OutputLine }
  | { kind: "exit"; code: number }
  | { kind: "error"; message: string }
  | ({ kind: "report" } & Report);

export type CaseStatus = "passed" | "failed" | "skipped";

// A case, at its path: the suites it is nested in, then its own name.
export interface Case {
  path: string[];
  status: CaseStatus;
  message?: string;
  durationMs?: number;
}

export interface SuiteDuration {
  path: string[];
  durationMs: number;
}

// The cases a report lists, the times it gives for suites, and what was
// wrong with it as a whole, such as a TAP stream that ended before its plan
// was met.
export interface ParsedReport {
  cases: Case[];
  suites?: SuiteDuration[];
  problem?: string;
}
