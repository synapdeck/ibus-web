// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

export type Setting = { schema: string; key: string; value: string };
export type Step =
  | { op: "create"; context: string; engine: string }
  | { op: "destroy"; context: string }
  | { op: "call"; context: string; method: string; args: string }
  | { op: "wait"; context: string; event: string; timeoutMs: number };
export type Trace = { version: 1; settings: Setting[]; steps: Step[] };

export type TypedValue = { signature: string; text: string };
export type ReplyValue = string | number | boolean | null | TypedValue;
export type TranscriptRecord =
  | { kind: "event"; step: number; context: string; name: string; payload: TypedValue }
  | { kind: "reply"; step: number; value: ReplyValue }
  | { kind: "error"; step: number; message: string };
export type Difference = { step: number; field: string; native: unknown; wasm: unknown };

export type RunOptions = { artifactDir: string; timeoutMs: number; signal?: AbortSignal };
export type RunResult = {
  records: TranscriptRecord[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  rawTranscript: string;
  artifactDir: string;
};
