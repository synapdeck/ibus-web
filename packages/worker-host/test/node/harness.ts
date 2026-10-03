// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The scenarios' harness under Node: hosts in worker_threads, driven from
// this thread, which blocks for each reply as the page's synchronous path
// would spin, and everything the hosts' threads print, taken by the tests.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";
import { createControl } from "../../src/shared/control.ts";
import type { HostInit, SideModule } from "../../src/shared/messages.ts";
import { encodeComponent } from "../../src/shared/naming.ts";
import { startHost } from "../shared/bootstrap.ts";
import { blockingClient, type Clock } from "../shared/client.ts";
import { hostUrlFor, startingAsAPage, type Harness, type HostOptions, type RunningHost } from "../shared/harness.ts";
import { locksFrom, type WebLocks } from "../shared/locks.ts";
import { printedFrom } from "../shared/printed.ts";
import type { TestInit } from "../shared/testing.ts";
import { BrowserWorker } from "./browser-worker.ts";

// A call holds this thread for at most this long, then waits up to the
// second limit without holding it; a reply that needed the wait fails the
// test that waited.
const BUDGET_MS = 1000;
const LATE_REPLY_MS = 30_000;

const clock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
  const compiled = new Map<string, WebAssembly.Module>();
  const runtimeModule = async (url: string): Promise<WebAssembly.Module> => {
    const wasm = url.replace(/\.js$/, ".wasm");
    let module = compiled.get(wasm);
    if (module === undefined) {
      module = await WebAssembly.compile(new Uint8Array(await bytesOf(wasm)));
      compiled.set(wasm, module);
    }
    return module;
  };
  const locks = locksFrom(navigator.locks as unknown as WebLocks, (ms) => AbortSignal.timeout(ms) as never);
  const start = async (options: HostOptions): Promise<RunningHost> => {
    const control = createControl();
    const worker = new BrowserWorker(hostUrlFor(data, options));
    const minimum = data.constants.memory.minimum;
    const test: TestInit = {
      mallinfo: data.constants.mallinfo,
      ...(options.config === undefined ? {} : { config: options.config }),
      ...(options.relayFailsAfter === undefined ? {} : { relayFailsAfter: options.relayFailsAfter }),
      ...options.test,
    };
    const init: HostInit<WebAssembly.Module, TestInit> = {
      runtimeUrl: options.runtime.url,
      wasm:
        options.wasm === undefined
          ? await runtimeModule(options.runtime.url)
          : await WebAssembly.compile(new Uint8Array(options.wasm)),
      memory: options.memory ?? { initial: minimum, maximum: minimum },
      control,
      sides: [...sides, ...(options.moreSides ?? [])],
      engine: options.engine ?? { name: "test", version: "0", data: [] },
      storage: options.storage ?? { kind: "none" },
      poolLowWater: data.pool.lowWater,
      constants: data.constants,
      test,
    };
    try {
      const { startupMs, messages } = await startHost(worker, init);
      return {
        client: blockingClient(control, messages, {
          ...clock,
          block: (words, index, value, ms) => {
            Atomics.wait(words, index, value, ms);
          },
          budgetMs: BUDGET_MS,
          lateReply: {
            wait: async (words, index, value, ms) => {
              const result = Atomics.waitAsync(words, index, value, ms);
              if (result.async) await result.value;
            },
            ms: LATE_REPLY_MS,
          },
        }),
        instrumented: options.released !== true,
        startupMs,
        messages,
        terminate: () => worker.terminate(),
      };
    } catch (error) {
      await worker.terminate();
      throw error;
    }
  };
  return {
    ...clock,
    data,
    sides,
    start: startingAsAPage(start, locks),
    locks,
    storage: (engine) => {
      const hostPath = join(scratch, "engines", encodeComponent(engine.name));
      mkdirSync(hostPath, { recursive: true });
      return { kind: "node", hostPath };
    },
    storageMount: "node",
    withoutIndexedDB: {},
    printed: printedFrom(drain, clock),
    record: (name, measurements) => console.log(`${name}: ${JSON.stringify(measurements)}`),
    pendingLimitMs: 10_000,
  };
};
