// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What a test environment gives the scenarios: the build's values, and hosts
// to run them against.

import type { TransportLayout } from "@ibus-web/protocol/transport";
import type { HostConfigValues } from "../../src/shared/config.ts";
import type { EngineManifest, EngineStorage, RuntimeConstants, SideModule } from "../../src/shared/messages.ts";
import { engineWriterLock } from "../../src/shared/naming.ts";
import type { Client, Clock } from "./client.ts";
import type { Message, TestInit } from "./testing.ts";
import type { Locks } from "./locks.ts";
import type { Printed } from "./printed.ts";

// Values the test side modules and the runtime's build define, printed by
// the build for the WebAssembly target.
export interface BuildConstants extends RuntimeConstants {
  // The test side modules' opcodes, by their C names without TEST_OP_.
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

// A test archive of engine data as its build describes it, and where hosts
// fetch it: its file name, a version derived from its bytes, its size
// unpacked, and the listing of the tree it installs, as list-tree prints it.
export interface TestArchive {
  archive: string;
  version: string;
  size: number;
  listing: string;
  url: string;
}

// What Vitest's configuration provides each environment's tests, with
// locations as that environment loads them.
export interface TestData {
  engines: Record<"echo" | "thrower" | "empty" | "rebuilt", EngineManifest>;
  echoData: string;
  schemaFiles: number;
  runtimes: RuntimeBuild[];
  brokenRuntimes: string[];
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
  // The engine's data, the next version's, which drops a file and turns
  // another into a directory, and a URL where no archive is.
  archives: { tree: TestArchive; upgrade: TestArchive; missing: string };
}

export interface HostOptions {
  layout?: TransportLayout;
  runtime: RuntimeBuild;
  // The engine the host runs, by default one of no storage's named "test".
  engine?: EngineManifest;
  manifest?: EngineManifest;
  manifestUrl?: string;
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
  // Every message but "ready", as this thread's event loop receives it.
  messages: Message[];
  terminate(): Promise<void>;
}

// A host started without waiting for it to be ready.
export interface LaunchedHost {
  messages: readonly Message[];
  // Rejects with why the host didn't start, leaving its Worker alive, as a
  // failed host stays to say why.
  ready: Promise<RunningHost>;
  terminate(): Promise<void>;
}

// Launches a host whose messages go to messages.
export type Launch = (options: HostOptions, messages: Message[]) => LaunchedHost;

export interface Harness extends Clock {
  data: TestData;
  // The test side modules, which every host loads.
  sides: readonly SideModule[];
  launch(options: HostOptions): LaunchedHost;
  // A host once ready; one that fails to start is terminated.
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
  // The versions, encoded, whose data the engine's storage keeps.
  versions(engine: EngineManifest): Promise<string[]>;
  // Leaves the marker of the engine's version as a write cut short would: a
  // file holding part of it under Node, a value that isn't one in
  // IndexedDB.
  tearMarker(engine: EngineManifest): Promise<void>;
  // Leaves <version>.marking beside the engine's data, as a host that
  // stopped while writing a marker would. Node only.
  strayMarking?: (engine: EngineManifest, version: string) => Promise<void>;
  // The names under the engine's data directory on the host, sorted. Node
  // only.
  dataEntries?: (engine: EngineManifest) => Promise<string[]>;
  // Opens the database of the engine's version's data on a connection that
  // ignores requests to close; resolves with what closes it. Browsers only.
  holdDataDatabase?: (engine: EngineManifest) => Promise<() => void>;
  // Removes the storage the hosts left behind, once none runs.
  cleanUp(): Promise<void>;
  printed: Printed;
  // Records a test's measurements in its output.
  record(name: string, measurements: Record<string, unknown>): void;
  // How long a result may stay pending before a scenario gives up on it.
  pendingLimitMs: number;
}

// How long a test build's host waits for a crashed thread's own error
// before it reports the crash without it, far past the moment the error
// takes, so that a loaded machine never cuts the report short.
export const CRASH_WAIT_MS = 10_000;

// A crash report comes within the host's wait for the thread's error, and
// reaches this thread well within as long again.
export const CRASH_REPORT_LIMIT_MS = 2 * CRASH_WAIT_MS;

// The configuration a test build's host runs with: the test's own, over
// the host's defaults but for its wait for a crashed thread's error.
export const testHostConfig = (options: HostOptions): Partial<HostConfigValues> => ({
  crashWaitMs: CRASH_WAIT_MS,
  ...options.config,
});

declare module "vitest" {
  interface ProvidedContext {
    workerHost: TestData;
  }
}

const reportedReadOnly = (messages: readonly Message[]): boolean =>
  messages.some((message) => message.type === "storage" && message.state === "read-only");

// Launches hosts as a page does. Chromium lets go of the locks of a Worker
// terminated while it sleeps in Atomics.wait() only some 2 s after
// terminate(), so a host started at once for the same engine would find the
// writer lock taken and run read-only for good. So once it has terminated a
// host with storage that didn't report storage: read-only, or seen one fail
// to start, it starts that engine's next host only when the writer lock is
// free, or once the wait's bound has passed, when another host holds it.
export const launchingAsAPage = (launch: Launch, locks: Locks): ((options: HostOptions) => LaunchedHost) => {
  const releasing = new Map<string, Promise<unknown>>();
  return (options) => {
    const messages: Message[] = [];
    const { engine, storage } = options;
    if (engine === undefined || storage === undefined || storage.kind === "none") return launch(options, messages);
    const released = (): void => {
      releasing.set(engine.name, locks.released(engineWriterLock(engine)));
    };
    let launched: LaunchedHost | undefined;
    let terminated = false;
    const terminate = async (): Promise<void> => {
      terminated = true;
      if (launched === undefined) return;
      await launched.terminate();
      if (!reportedReadOnly(messages)) released();
    };
    const ready = (async () => {
      await releasing.get(engine.name);
      if (terminated) throw new Error("terminated before it started");
      launched = launch(options, messages);
      const host = await launched.ready.catch((error: unknown) => {
        released();
        throw error;
      });
      return { ...host, terminate };
    })();
    return { messages, ready, terminate };
  };
};

// Starts the host and waits for it to be ready; terminates one that fails.
export const startFrom =
  (launch: (options: HostOptions) => LaunchedHost) =>
  async (options: HostOptions): Promise<RunningHost> => {
    const launched = launch(options);
    try {
      return await launched.ready;
    } catch (error) {
      await launched.terminate();
      throw error;
    }
  };

// The host's script for options.
export const hostUrlFor = (data: TestData, options: HostOptions): string => {
  if (options.released !== true) return data.testHostUrl;
  if (options.relayFailsAfter === undefined) return data.hostUrl;
  if (options.relayFailsAfter !== 3) throw new Error("the host as released takes only a relay that fails after 3");
  return data.hostWithFailingRelayUrl;
};
