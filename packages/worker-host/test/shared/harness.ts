// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What a test environment gives the scenarios: the build's values, and hosts
// to run them against.

import type { ModuleManifest } from "@ibus-web/protocol";
import type { TransportLayout } from "@ibus-web/protocol/transport";
import type { HostConfigValues } from "../../src/shared/config.ts";
import { controlViews, createControl, postMail } from "../../src/shared/control.ts";
import type {
  EngineStorage,
  HostInit,
  PreparedReport,
  PrepareEngine,
  RuntimeConstants,
  SideModule,
} from "../../src/shared/messages.ts";
import { engineWriterLock } from "../../src/shared/naming.ts";
import { startHost, type HostWorker } from "./bootstrap.ts";
import { blockingClient, type BlockingClientEnv, type Client, type Clock } from "./client.ts";
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
  engines: Record<"echo" | "thrower" | "empty" | "rebuilt" | "lazy", ModuleManifest>;
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
  // another into a directory, the engine's data again under two store paths
  // of their own, a URL where no archive is, and the installer's own
  // archives.
  archives: {
    tree: TestArchive;
    upgrade: TestArchive;
    lazy: TestArchive;
    lazy2: TestArchive;
    missing: string;
    installer: InstallerArchives;
  };
}

// The archives the installer's own tests take: each is at base followed by
// its file name, refused/*.tar under the store path refused, and long.tar
// under long.storeName, with a name and a link target too long for ustar.
export interface InstallerArchives {
  base: string;
  data: string;
  refused: string;
  long: { storeName: string; name: string; target: string };
}

export interface HostOptions {
  layout?: TransportLayout;
  runtime: RuntimeBuild;
  // The engine the host runs, by default one of no storage's named "test".
  engine?: ModuleManifest;
  manifest?: ModuleManifest;
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

// A PrepareEngine's answer, as the host posts it.
export type Prepared = { type: "prepared" } & PreparedReport;

export interface RunningHost {
  client: Client;
  // Posts PrepareEngine for the engine, as a page does, and resolves with
  // the host's answer.
  prepare(engine: string): Promise<Prepared>;
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
  storage(engine: ModuleManifest): EngineStorage;
  storageMount: "indexeddb" | "node";
  // What leaves a host told to mount IndexedDB without it: under Node,
  // nothing, since Node has none; in a browser, a host that throws as an
  // opaque origin's indexedDB.open() does.
  withoutIndexedDB: Partial<TestInit>;
  // Opens the engine's database at its next version and closes it again, as
  // an upgrade in another tab would; resolves once it opened, with how long
  // that took in milliseconds. Browsers only.
  upgradeDatabase?: (engine: ModuleManifest) => Promise<number>;
  locks: Locks;
  // The versions, encoded, whose data the engine's storage keeps.
  versions(engine: ModuleManifest): Promise<string[]>;
  // Leaves the marker of the engine's version as a write cut short would: a
  // file holding part of it under Node, a value that isn't one in
  // IndexedDB.
  tearMarker(engine: ModuleManifest): Promise<void>;
  // Leaves <version>.marking beside the engine's data, as a host that
  // stopped while writing a marker would. Node only.
  strayMarking?: (engine: ModuleManifest, version: string) => Promise<void>;
  // The names under the engine's data directory on the host, sorted. Node
  // only.
  dataEntries?: (engine: ModuleManifest) => Promise<string[]>;
  // Opens the database of the engine's version's data on a connection that
  // ignores requests to close; resolves with what closes it. Browsers only.
  holdDataDatabase?: (engine: ModuleManifest) => Promise<() => void>;
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

// A caller past its budget waits up to this long more for a reply without
// holding its thread; a reply that needed the wait fails the test that
// waited.
export const LATE_REPLY_MS = 30_000;

// How long a PrepareEngine may take before a test gives up on it: an
// install of the test archives takes well under a second.
export const PREPARE_LIMIT_MS = 30_000;

// Waits while words[index] is value, for at most ms, without holding the
// thread.
export const waitFree = async (words: Int32Array, index: number, value: number, ms: number): Promise<void> => {
  const result = Atomics.waitAsync(words, index, value, ms);
  if (result.async) await result.value;
};

// Compiles each runtime's module once, by its .wasm beside the runtime's
// script.
export const runtimeModules = <Wasm>(
  compile: (wasmUrl: string) => Promise<Wasm>,
): ((runtimeUrl: string) => Promise<Wasm>) => {
  const compiled = new Map<string, Promise<Wasm>>();

  return (runtimeUrl) => {
    const wasm = runtimeUrl.replace(/\.js$/, ".wasm");
    let module = compiled.get(wasm);

    if (module === undefined) {
      module = compile(wasm);
      compiled.set(wasm, module);
    }

    return module;
  };
};

// What a host's Worker is to the harness: a browser's Worker, or Node's
// stand-in for one.
export interface LaunchedWorker extends HostWorker {
  terminate(): unknown;
}

// Where launching a host differs between test environments.
export interface LaunchEnv<Wasm> extends Clock {
  data: TestData;
  sides: readonly SideModule[];
  worker(url: string): LaunchedWorker;
  // A URL as the host's Worker loads it.
  resolve(url: string): string;
  runtimeModule(runtimeUrl: string): Promise<Wasm>;
  compile(bytes: Uint8Array): Promise<Wasm>;
  // How the caller holds its thread for a reply; a thread that can't block
  // returns at once and spins.
  block: BlockingClientEnv["block"];
  budgetMs: number;
}

// Launches hosts the same way in every environment: the test build's
// HostInit, then a client that holds the caller's thread for each reply.
export const hostLauncher =
  <Wasm>(env: LaunchEnv<Wasm>): Launch =>
  (options, messages) => {
    const { data } = env;
    const control = createControl(options.layout);
    const worker = env.worker(hostUrlFor(data, options));
    const minimum = data.constants.memory.minimum;
    const test: TestInit = {
      mallinfo: data.constants.mallinfo,
      sides: [...env.sides, ...(options.moreSides ?? [])],
      config: testHostConfig(options),
      ...(options.relayFailsAfter === undefined ? {} : { relayFailsAfter: options.relayFailsAfter }),
      ...options.test,
    };

    // A browser's terminate() returns before its Worker has stopped; Node's
    // stand-in settles once it has.
    const terminate = async (): Promise<void> => {
      await worker.terminate();
    };

    const ready = (async (): Promise<RunningHost> => {
      const init: HostInit<Wasm, TestInit> = {
        runtimeUrl: env.resolve(options.runtime.url),
        wasm:
          options.wasm === undefined ? await env.runtimeModule(options.runtime.url) : await env.compile(options.wasm),
        control,
        ...(options.layout === undefined ? {} : { layout: options.layout }),
        ...(options.manifestUrl === undefined
          ? {
              manifest: {
                ...(options.manifest ?? options.engine ?? data.engines.empty),
                memory: options.memory?.initial ?? options.manifest?.memory ?? options.engine?.memory ?? minimum,
              },
            }
          : { manifestUrl: env.resolve(options.manifestUrl) }),
        storage: options.storage ?? { kind: "none" },
        test,
      };
      const startupMs = await startHost(worker, init, messages);

      const client = blockingClient(
        control,
        messages,
        {
          now: env.now,
          sleep: env.sleep,
          schedule: env.schedule,
          block: env.block,
          budgetMs: env.budgetMs,
          lateReply: { wait: waitFree, ms: LATE_REPLY_MS },
        },
        options.layout,
      );
      worker.addEventListener("message", ({ data }) => {
        if ((data as Message).type === "doorbell") client.page.onDoorbell();
        if ((data as Message).type === "crashed") client.page.onCrash();
      });

      const views = controlViews(control, options.layout);
      const prepare = async (engine: string): Promise<Prepared> => {
        const from = messages.length;
        worker.postMessage({ type: "prepare-engine", engine } satisfies PrepareEngine);
        postMail(views);
        const deadline = env.now() + PREPARE_LIMIT_MS;
        for (;;) {
          const answer = messages
            .slice(from)
            .find((message): message is Prepared => message.type === "prepared" && message.engine === engine);
          if (answer !== undefined) return answer;
          if (env.now() >= deadline) throw new Error(`prepare ${engine}: no answer in ${PREPARE_LIMIT_MS} ms`);
          await env.sleep(5);
        }
      };

      return {
        client,
        prepare,
        instrumented: options.released !== true,
        startupMs,
        messages,
        terminate,
      };
    })();

    return { messages, ready, terminate };
  };
