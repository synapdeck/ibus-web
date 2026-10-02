// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// How the harnesses print a host's results, and what a page run reports.

import type { BuildConstants, HostFeatures, HostMessage, TestData, WaitMode } from "./control.ts";
import type { Result } from "./scenarios.ts";

// What a harness asks the page to run, on a host of its own.
export interface PageRunSpec {
  // URLs, resolved against the page's.
  runtimeUrl: string;
  sideUrls: string[];
  wait: WaitMode;
  // Scenario names, run in this order. With install, they are install
  // scenarios, each starting hosts of its own, rather than ones run on one
  // host.
  scenarios: string[];
  install?: boolean;
  // The test archive, which the engine installs as its data, and its URL,
  // resolved against the page's; without them, the engine has no data.
  data?: TestData;
  dataUrl?: string;
  constants: BuildConstants;
  errno: Record<string, number>;
  poolSize: number;
  plannedThreads: number;
  engineThreads: number;
  glibThreads: number;
  poolLowWater: number;
  pendingLimitMs: number;
  // Env.wakeMaxMs.
  wakeMaxMs?: number;
  // How the page waits for each reply: "spin" holds its main thread, as the
  // synchronous keystroke path would; "async" waits with Atomics.waitAsync(),
  // its event loop running.
  pageWait: "spin" | "async";
  // What the host mounts at the engine's directory: nothing, or the engine's
  // IndexedDB database, with or without IndexedDB to open (Storage).
  storage: "none" | "browser" | "browser-without-indexeddb";
  // The runtime's memory (HostInit.memory).
  memory: { initial: number; maximum: number };
  stress?: { threads: number; rounds: number; iterations: number };
  // Whether the page measures the memory its Workers use, for worker-memory.
  sampleMemory?: boolean;
  // The engine's name, if not the spike's own; it names the engine's
  // storage.
  engineName?: string;
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

const format = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

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
    for (const [key, value] of Object.entries(measurements)) lines.push(`    ${key}: ${format(value)}`);
    if (error !== undefined) lines.push(`    error: ${error}`);
  }
  for (const message of messages) {
    const text =
      message.type === "install" || message.type === "collect" || message.type === "waiting"
        ? JSON.stringify(message)
        : `${message.type === "storage" ? `${message.state}: ` : ""}${"message" in message ? message.message : ""}`;
    lines.push(`    host ${message.type}: ${text}`);
  }
  lines.push(`RESULTS ${JSON.stringify({ label, startupMs, results })}`);
  return lines;
};
