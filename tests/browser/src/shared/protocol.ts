// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the runner, the page and a program's Worker pass each other.

// The runner asks the page to run one program.
export interface ProgramSpec {
  // The program's Emscripten-built module script, relative to the page.
  url: string;
  args: string[];
  timeoutMs: number;
}

export interface OutputLine {
  stream: "stdout" | "stderr";
  text: string;
}

// What the page answers. exitCode is null when the program never exited,
// and error then says why.
export interface ProgramReport {
  output: OutputLine[];
  exitCode: number | null;
  error?: string;
}

// The page's one message to a program's Worker.
export interface StartMessage {
  // Absolute: the Worker resolves it against its own script's URL otherwise.
  url: string;
  args: string[];
}

export type WorkerMessage =
  | { kind: "output"; line: OutputLine }
  | { kind: "exit"; code: number }
  | { kind: "error"; message: string };
