// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What a test environment gives the scenarios: the build's values, and hosts
// to run them against.

import type { HostConfigValues } from "../../src/shared/config.ts";
import type {
  EngineManifest,
  EngineStorage,
  HostMessage,
  RuntimeConstants,
  SideModule,
} from "../../src/shared/messages.ts";
import { engineWriterLock } from "../../src/shared/naming.ts";
import type { Client, Clock } from "./client.ts";
import type { TestInit } from "./testing.ts";
import type { Locks } from "./locks.ts";
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
  // The engine the host runs, by default one of no storage's named "test".
  engine?: EngineManifest;
  storage?: EngineStorage;
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
  // Side modules the host loads after the test side modules.
  moreSides?: SideModule[];
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
  // The test side modules, which every host loads.
  sides: readonly SideModule[];
  start(options: HostOptions): Promise<RunningHost>;
  // The storage that outlives a host, which every host for the engine in
  // this environment shares: in a browser, the engine's IndexedDB
  // database; under Node, a directory of the engine's own. And what the
  // host mounts it on.
  storage(engine: EngineManifest): EngineStorage;
  storageMount: "indexeddb" | "node";
  // What leaves a host told to mount IndexedDB without it: under Node,
  // nothing, since Node has none; in a browser, a host that throws as an
  // opaque origin's indexedDB.open() does.
  withoutIndexedDB: Partial<TestInit>;
  // Opens the engine's database at its next version and closes it again, as
  // an upgrade in another tab would; resolves once it opened, with how long
  // that took in milliseconds. Browsers only.
  upgradeDatabase?: (engine: EngineManifest) => Promise<number>;
  locks: Locks;
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

const reportedReadOnly = (messages: readonly HostMessage[]): boolean =>
  messages.some((message) => message.type === "storage" && message.state === "read-only");

// Starts hosts as a page does. Chromium lets go of the locks of a Worker
// terminated while it sleeps in Atomics.wait() only some 2 s after
// terminate(), so a host started at once for the same engine would find the
// writer lock taken and run read-only for good. So once it has terminated a
// host with storage that didn't report storage: read-only, it starts that
// engine's next host only when the writer lock is free, or once the wait's
// bound has passed, when another host holds it.
export const startingAsAPage = (
  start: (options: HostOptions) => Promise<RunningHost>,
  locks: Locks,
): ((options: HostOptions) => Promise<RunningHost>) => {
  const releasing = new Map<string, Promise<unknown>>();
  return async (options) => {
    const { engine, storage } = options;
    if (engine === undefined || storage === undefined || storage.kind === "none") return start(options);
    await releasing.get(engine.name);
    const released = (): void => {
      releasing.set(engine.name, locks.released(engineWriterLock(engine)));
    };
    const host = await start(options).catch((error: unknown) => {
      released();
      throw error;
    });
    return {
      ...host,
      terminate: async () => {
        await host.terminate();
        if (!reportedReadOnly(host.messages)) released();
      },
    };
  };
};

// The host's script for options.
export const hostUrlFor = (data: TestData, options: HostOptions): string => {
  if (options.released !== true) return data.testHostUrl;
  if (options.relayFailsAfter === undefined) return data.hostUrl;
  if (options.relayFailsAfter !== 3) throw new Error("the host as released takes only a relay that fails after 3");
  return data.hostWithFailingRelayUrl;
};
