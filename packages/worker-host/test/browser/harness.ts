// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The scenarios' harness in a browser: hosts started by URL from the built
// package, driven from the page's main thread, which can't block, so it
// spins for each reply as the synchronous keystroke path would, and what the
// hosts' Workers print to their consoles, taken by the tests.

import { inject } from "vitest";
import { commands } from "vitest/browser";
import { createControl } from "../../src/shared/control.ts";
import type { HostInit, SideModule } from "../../src/shared/messages.ts";
import { startHost } from "../shared/bootstrap.ts";
import { blockingClient, type Clock } from "../shared/client.ts";
import { hostUrlFor, type Harness, type HostOptions, type RunningHost } from "../shared/harness.ts";
import { printedFrom } from "../shared/printed.ts";
import type { TestInit } from "../shared/testing.ts";
import "./commands.ts";

// A spinning page gives up on a reply after this long, twenty times the
// longest any request takes when nothing waits for the page (Chromium's
// spawn(4), some 50 ms), then waits for it without holding its thread, up to
// the second limit more: a reply that comes only then needed the page's main
// thread, and fails the test that waited.
const SPIN_LIMIT_MS = 1000;
const LATE_REPLY_MS = 30_000;

const clock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const fetchOk = async (url: string): Promise<Response> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
};

const waitFree = async (words: Int32Array, index: number, value: number, ms: number): Promise<void> => {
  const result = Atomics.waitAsync(words, index, value, ms);
  if (result.async) await result.value;
};

export const browserHarness = async (): Promise<Harness> => {
  if (!crossOriginIsolated) throw new Error("the page is not cross-origin isolated");
  await commands.consoleBegin();
  const data = inject("workerHost");
  const sides: SideModule[] = await Promise.all(
    data.sides.map(async ({ name, url }) => ({ name, bytes: await (await fetchOk(url)).arrayBuffer() })),
  );
  const compiled = new Map<string, Promise<WebAssembly.Module>>();
  const runtimeModule = (url: string): Promise<WebAssembly.Module> => {
    const wasm = url.replace(/\.js$/, ".wasm");
    let module = compiled.get(wasm);
    if (module === undefined) {
      module = WebAssembly.compileStreaming(fetchOk(wasm));
      compiled.set(wasm, module);
    }
    return module;
  };
  const start = async (options: HostOptions): Promise<RunningHost> => {
    const control = createControl();
    const worker = new Worker(hostUrlFor(data, options), {
      type: "module",
      name: "ibus-web-host",
    });
    const minimum = data.constants.memory.minimum;
    const test: TestInit = {
      mallinfo: data.constants.mallinfo,
      ...(options.config === undefined ? {} : { config: options.config }),
      ...(options.relayFailsAfter === undefined ? {} : { relayFailsAfter: options.relayFailsAfter }),
      ...options.test,
    };
    const init: HostInit<WebAssembly.Module, TestInit> = {
      runtimeUrl: new URL(options.runtime.url, location.href).href,
      wasm:
        options.wasm === undefined
          ? await runtimeModule(options.runtime.url)
          : await WebAssembly.compile(new Uint8Array(options.wasm)),
      memory: options.memory ?? { initial: minimum, maximum: minimum },
      control,
      sides,
      engine: { name: "test", version: "0", data: [] },
      poolLowWater: data.pool.lowWater,
      constants: data.constants,
      test,
    };
    try {
      const { startupMs, messages } = await startHost(worker, init);
      return {
        client: blockingClient(control, messages, {
          ...clock,
          block: () => {},
          budgetMs: SPIN_LIMIT_MS,
          lateReply: { wait: waitFree, ms: LATE_REPLY_MS },
        }),
        instrumented: options.released !== true,
        startupMs,
        messages,
        // A browser's terminate() returns before the Worker has stopped;
        // nothing here waits for that.
        terminate: async () => worker.terminate(),
      };
    } catch (error) {
      worker.terminate();
      throw error;
    }
  };
  return {
    ...clock,
    data,
    start,
    printed: printedFrom(() => commands.consoleTake(), clock),
    record: (name, measurements) => console.log(`${name}: ${JSON.stringify(measurements)}`),
    pendingLimitMs: 10_000,
  };
};
