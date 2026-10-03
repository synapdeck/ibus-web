// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What a test environment gives the scenarios: the build's values, and hosts
// to run them against.

import type { HostConfigValues } from "../../src/shared/config.ts";
import type { HostMessage, RuntimeConstants } from "../../src/shared/messages.ts";
import type { Client, Clock } from "./client.ts";
import type { TestInit } from "./testing.ts";
import type { Printed } from "./printed.ts";

// Values the test side modules and the runtime's build define, printed by
// the build for the WebAssembly target.
export interface BuildConstants extends RuntimeConstants {
  // The test side modules' opcodes, by their C names without SPIKE_OP_.
  ops: Readonly<Record<string, number>>;
  // struct mallinfo's size, and the offset of uordblks (bytes in use).
  mallinfo: { bytes: number; inUseOffset: number };
}

export interface RuntimeBuild {
  name: "asserting" | "released";
  // ibus-runtime.js, as this environment loads it; ibus-runtime.wasm is
  // beside it.
  url: string;
}

// What Vitest's configuration provides each environment's tests, with
// locations as that environment loads them.
export interface TestData {
  runtimes: RuntimeBuild[];
  sides: { name: string; url: string }[];
  // The host's test build and the host as released; and the host as
  // released beside the relay that fails after three wakes, as its relay.
  testHostUrl: string;
  hostUrl: string;
  hostWithFailingRelayUrl: string;
  constants: BuildConstants;
  // Emscripten's errno values, by name.
  errno: Readonly<Record<string, number>>;
  // The pthread pool the runtime is linked with: its size at start, the
  // threads its shares plan for, the shares of the test side modules and of
  // GLib (what one GTask in flight keeps alive), and the spare Workers beyond
  // the shares, which the host tops the pool back up to.
  pool: { size: number; planned: number; engine: number; glib: number; lowWater: number };
  // The memory workloads: threads alive at once, mem-stress's rounds per
  // thread and glib-stress's lock takes per thread.
  stress: { threads: number; rounds: number; iterations: number };
}

export interface HostOptions {
  runtime: RuntimeBuild;
  // The runtime's memory; its least by default.
  memory?: { initial: number; maximum: number };
  config?: Partial<HostConfigValues>;
  // Starts the relay that fails once it has forwarded this many wakes; the
  // host as released takes only 3.
  relayFailsAfter?: number;
  // More for HostInit.test, which only the test build reads.
  test?: Partial<TestInit>;
  // Starts the host as released rather than its test build. It has no
  // instruments: HostOp requests reach the runtime.
  released?: boolean;
  // Hands the host this module as the runtime's, compiled, instead.
  wasm?: Uint8Array;
}

export interface RunningHost {
  client: Client;
  // Whether the host is the test build, which answers HostOp requests.
  instrumented: boolean;
  startupMs: number;
  messages: HostMessage[];
  terminate(): Promise<void>;
}

export interface Harness extends Clock {
  data: TestData;
  start(options: HostOptions): Promise<RunningHost>;
  printed: Printed;
  // Records a test's measurements in its output.
  record(name: string, measurements: Record<string, unknown>): void;
  // How long a result may stay pending before a scenario gives up on it.
  pendingLimitMs: number;
}

declare module "vitest" {
  interface ProvidedContext {
    workerHost: TestData;
  }
}

// The host's script for options.
export const hostUrlFor = (data: TestData, options: HostOptions): string => {
  if (options.released !== true) return data.testHostUrl;
  if (options.relayFailsAfter === undefined) return data.hostUrl;
  if (options.relayFailsAfter !== 3) throw new Error("the host as released takes only a relay that fails after 3");
  return data.hostWithFailingRelayUrl;
};
