// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The scenarios' harness in a browser: hosts started by URL from the built
// package, driven from the page's main thread, which can't block, so it
// spins for each reply as the synchronous keystroke path would, and what the
// hosts' Workers print to their consoles, taken by the tests.

import type { EngineManifest } from "@ibus-web/protocol";
import { inject } from "vitest";
import { commands } from "vitest/browser";
import type { SideModule } from "../../src/shared/messages.ts";
import { engineDatabase, engineDataDatabase, engineDataDatabasePrefix } from "../../src/shared/naming.ts";
import type { Clock } from "../shared/client.ts";
import {
  hostLauncher,
  launchingAsAPage,
  runtimeModules,
  startFrom,
  type Harness,
  type Launch,
} from "../shared/harness.ts";
import { LOCK_RELEASE_LIMIT_MS, locksFrom, type WebLocks } from "../shared/locks.ts";
import { printedFrom } from "../shared/printed.ts";
import "./commands.ts";

// A spinning page gives up on a reply after this long, twenty times the
// longest any request takes when nothing waits for the page (Chromium's
// spawn(4), some 50 ms), then waits for it without holding its thread: a
// reply that comes only then needed the page's main thread.
const SPIN_LIMIT_MS = 1000;

// A bound on a console line's way to the commands, for a loaded machine.
const SETTLE_LIMIT_MS = 10_000;

const clock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  schedule: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

const fetchOk = async (url: string): Promise<Response> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
};

const opened = (request: IDBOpenDBRequest): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

// Opening a database at a newer version waits until every other connection
// to it has closed.
const upgradeDatabase = async (engine: EngineManifest): Promise<number> => {
  const startedAt = performance.now();
  const name = engineDatabase(engine);
  const current = await opened(indexedDB.open(name));
  const { version } = current;
  current.close();
  (await opened(indexedDB.open(name, version + 1))).close();
  return performance.now() - startedAt;
};

// Writes what isn't a marker where the version's marker is, as a write cut
// short would leave it.
const tearMarker = async (engine: EngineManifest): Promise<void> => {
  const db = await opened(indexedDB.open(engineDataDatabase(engine)));
  try {
    const tx = db.transaction("meta", "readwrite");
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    tx.objectStore("meta").put('{"vers', "installed");
    await done;
  } finally {
    db.close();
  }
};

// Deletes the database, once every connection to it has closed: a
// terminated host's close as its Worker ends.
const deleteDatabase = (name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    const timer = setTimeout(
      () => reject(new Error(`deleting ${name}: still blocked after ${LOCK_RELEASE_LIMIT_MS} ms`)),
      LOCK_RELEASE_LIMIT_MS,
    );
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve();
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
  });

// What the page's Workers printed, once everything printed before the call
// has arrived. Their consoles reach the commands over the one connection to
// the browser, in the order the browser sends them, so once a line printed
// by a Worker started now has arrived, so has every line printed earlier.
const settledConsole = async (): Promise<string[]> => {
  const marker = `ibus-web-settled-${crypto.randomUUID()}`;
  const url = URL.createObjectURL(new Blob([`console.log(${JSON.stringify(marker)});`], { type: "text/javascript" }));
  const worker = new Worker(url);
  try {
    const lines: string[] = [];
    const deadline = performance.now() + SETTLE_LIMIT_MS;
    for (;;) {
      const taken = await commands.consoleTake();
      const at = taken.indexOf(marker);
      if (at >= 0) return [...lines, ...taken.slice(0, at), ...taken.slice(at + 1)];
      lines.push(...taken);
      if (performance.now() >= deadline) throw new Error(`a Worker's console line took over ${SETTLE_LIMIT_MS} ms`);
      await clock.sleep(5);
    }
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
};

export const browserHarness = async (): Promise<Harness> => {
  if (!crossOriginIsolated) throw new Error("the page is not cross-origin isolated");
  await commands.consoleBegin();
  const data = inject("workerHost");
  const sides: SideModule[] = await Promise.all(
    data.sides.map(async ({ name, url }) => ({ name, bytes: await (await fetchOk(url)).arrayBuffer() })),
  );
  const locks = locksFrom(navigator.locks as unknown as WebLocks, (ms) => AbortSignal.timeout(ms) as never);
  const launchHost = hostLauncher<WebAssembly.Module>({
    ...clock,
    data,
    sides,
    worker: (url) => new Worker(url, { type: "module", name: "ibus-web-host" }),
    resolve: (url) => new URL(url, location.href).href,
    runtimeModule: runtimeModules((wasm) => WebAssembly.compileStreaming(fetchOk(wasm))),
    compile: (bytes) => WebAssembly.compile(new Uint8Array(bytes)),
    block: () => {},
    budgetMs: SPIN_LIMIT_MS,
  });

  // The databases hosts were given, which outlive them.
  const databases = new Set<string>();
  const launch: Launch = (options, messages) => {
    if (options.storage?.kind === "browser" && options.engine !== undefined) {
      databases.add(engineDatabase(options.engine));
      if (options.engine.version !== "") databases.add(engineDataDatabase(options.engine));
    }

    return launchHost(options, messages);
  };
  const launchAsAPage = launchingAsAPage(launch, locks);
  return {
    ...clock,
    data,
    sides,
    launch: launchAsAPage,
    start: startFrom(launchAsAPage),
    locks,
    storage: () => ({ kind: "browser" }),
    versions: async (engine) => {
      const prefix = engineDataDatabasePrefix(engine);
      return (await indexedDB.databases()).flatMap(({ name }) =>
        name?.startsWith(prefix) === true ? [name.slice(prefix.length)] : [],
      );
    },
    tearMarker,
    // A connection without a versionchange handler stays open when another
    // asks it to close.
    holdDataDatabase: async (engine) => {
      const db = await opened(indexedDB.open(engineDataDatabase(engine)));
      return () => db.close();
    },
    storageMount: "indexeddb",
    withoutIndexedDB: { withoutIndexedDB: true },
    upgradeDatabase,
    cleanUp: async () => {
      await Promise.all([...databases].map(deleteDatabase));
      databases.clear();
    },
    printed: printedFrom(() => commands.consoleTake(), settledConsole, clock),
    record: (name, measurements) => console.log(`${name}: ${JSON.stringify(measurements)}`),
    pendingLimitMs: 10_000,
  };
};
