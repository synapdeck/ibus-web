// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// How the harnesses print a host's results, and what a page run reports.

import type {
  BuildConstants,
  HostFeatures,
  HostMessage,
  WaitMode,
} from "./control.ts";
import type { Result } from "./scenarios.ts";

// What a harness asks the page to run, on a host of its own.
export interface PageRunSpec {
  // URLs, resolved against the page's.
  runtimeUrl: string;
  sideUrls: string[];
  wait: WaitMode;
  // Scenario names, run in this order.
  scenarios: string[];
  constants: BuildConstants;
  errno: Record<string, number>;
  poolSize: number;
  plannedThreads: number;
  engineThreads: number;
  glibThreads: number;
  poolLowWater: number;
  pendingLimitMs: number;
  // How the page waits for each reply: "spin" holds its main thread, as the
  // synchronous keystroke path would; "async" waits with Atomics.waitAsync(),
  // its event loop running.
  pageWait: "spin" | "async";
  // Where the host mounts the OPFS backend, if it does.
  opfsMount?: string;
  // The runtime's memory (HostInit.memory).
  memory: { initial: number; maximum: number };
  stress?: { threads: number; rounds: number; iterations: number };
  // Whether the page measures the memory its Workers use, for worker-memory.
  sampleMemory?: boolean;
}

export interface PageRunReport {
  userAgent: string;
  // What Atomics.wait() did on the page's main thread.
  mainThreadAtomicsWait: string;
  // performance.now()'s step on the page's main thread.
  pageClockStepUs: number;
  startupMs: number;
  features: HostFeatures;
  results: Result[];
  // The host's messages after "ready".
  messages: HostMessage[];
}

const format = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

// A host's results, one line per scenario and measurement, then a RESULTS
// line with the same as JSON.
export const reportLines = (
  label: string,
  startupMs: number,
  results: readonly Result[],
  messages: readonly HostMessage[],
): string[] => {
  const lines = [`== ${label} (startup ${startupMs.toFixed(0)} ms)`];
  for (const { name, pass, criterion, measurements, error } of results) {
    lines.push(`${pass ? "PASS" : "FAIL"} ${name}: ${criterion}`);
    for (const [key, value] of Object.entries(measurements))
      lines.push(`    ${key}: ${format(value)}`);
    if (error !== undefined) lines.push(`    error: ${error}`);
  }
  for (const message of messages)
    lines.push(
      `    host ${message.type}: ${"message" in message ? message.message : ""}`,
    );
  lines.push(`RESULTS ${JSON.stringify({ label, startupMs, results })}`);
  return lines;
};
