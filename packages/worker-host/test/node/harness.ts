// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The scenarios' harness under Node: hosts in worker_threads, driven from
// this thread, which blocks for each reply as the page's synchronous path
// would spin, and everything the hosts' threads print, taken by the tests.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { ModuleManifest } from "@ibus-web/protocol";
import { inject } from "vitest";
import type { SideModule } from "../../src/shared/messages.ts";
import { encodeComponent } from "../../src/shared/naming.ts";
import type { Clock } from "../shared/client.ts";
import { hostLauncher, launchingAsAPage, runtimeModules, startFrom, type Harness } from "../shared/harness.ts";
import { locksFrom, type WebLocks } from "../shared/locks.ts";
import { printedFrom } from "../shared/printed.ts";
import { BrowserWorker } from "./browser-worker.ts";

// A call holds this thread for at most this long, then waits for the reply
// without holding it.
const BUDGET_MS = 1000;

const clock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  schedule: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

const scratch = mkdtempSync(join(tmpdir(), "ibus-web-worker-host-"));

// What the hosts' threads print goes to a file of this process's own.
const output = join(scratch, "output.txt");
process.env["IBUS_WEB_WORKER_HOST_OUTPUT"] = output;
writeFileSync(output, "");
let readTo = 0;
let partial = "";

// The lines printed since the last call: whole lines only, the rest kept
// for the next.
const drain = (): string[] => {
  const bytes = readFileSync(output).subarray(readTo);
  readTo += bytes.length;
  const lines = (partial + bytes.toString("utf8")).split("\n");
  partial = lines.pop()!;
  return lines.filter((line) => line !== "");
};

const bytesOf = async (url: string): Promise<ArrayBuffer> => {
  const bytes = await readFile(fileURLToPath(url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

export const nodeHarness = async (): Promise<Harness> => {
  const data = inject("workerHost");
  const sides: SideModule[] = await Promise.all(
    data.sides.map(async ({ name, url }) => ({ name, bytes: await bytesOf(url) })),
  );
  const locks = locksFrom(navigator.locks as unknown as WebLocks, (ms) => AbortSignal.timeout(ms) as never);
  const launch = hostLauncher<WebAssembly.Module>({
    ...clock,
    data,
    sides,
    worker: (url) => new BrowserWorker(url),
    resolve: (url) => url,
    runtimeModule: runtimeModules(async (wasm) => WebAssembly.compile(new Uint8Array(await bytesOf(wasm)))),
    compile: (bytes) => WebAssembly.compile(new Uint8Array(bytes)),
    block: (words, index, value, ms) => {
      Atomics.wait(words, index, value, ms);
    },
    budgetMs: BUDGET_MS,
  });

  const enginePath = (engine: Pick<ModuleManifest, "name">): string =>
    join(scratch, "engines", encodeComponent(engine.name));
  const dataPath = (engine: Pick<ModuleManifest, "name">): string => join(enginePath(engine), "data");
  const launchAsAPage = launchingAsAPage(launch, locks);
  return {
    ...clock,
    data,
    sides,
    launch: launchAsAPage,
    start: startFrom(launchAsAPage),
    locks,
    storage: (engine) => {
      const hostPath = enginePath(engine);
      mkdirSync(hostPath, { recursive: true });
      return { kind: "node", hostPath };
    },
    // A version's directory, its markers, or any of them.
    versions: async (engine) => [
      ...new Set(
        (await readdir(dataPath(engine)).catch(() => [] as string[])).map((name) =>
          name.replace(/\.(installed|marking|paths)$/, ""),
        ),
      ),
    ],
    tearMarker: (engine) => writeFile(join(dataPath(engine), `${encodeComponent(engine.version)}.installed`), '{"vers'),
    dataEntries: async (engine) => (await readdir(dataPath(engine))).sort(),
    strayMarking: async (engine, version) => {
      mkdirSync(dataPath(engine), { recursive: true });
      await writeFile(join(dataPath(engine), `${version}.marking`), JSON.stringify({ version, files: 0, bytes: 0 }));
    },
    storageMount: "node",
    cleanUp: async () => {
      rmSync(join(scratch, "engines"), { recursive: true, force: true });
    },
    withoutIndexedDB: {},
    // The hosts' threads write synchronously into the file drain() reads,
    // so what they printed is there already.
    printed: printedFrom(drain, drain, clock),
    record: (name, measurements) => console.log(`${name}: ${JSON.stringify(measurements)}`),
    pendingLimitMs: 10_000,
  };
};
