// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The page side of the browser harness. runSpike() starts a Worker host by
// URL, hands it the compiled runtime, the side modules' bytes and the
// control buffer, then runs scenarios against it over that buffer alone:
// the page never sees the runtime's memory.

import { startHost } from "../shared/bootstrap.ts";
import { blockingClient, clockStepUs } from "../shared/client.ts";
import {
  createControl,
  type HostInit,
  type SideModule,
} from "../shared/control.ts";
import type { PageRunReport, PageRunSpec } from "../shared/report.ts";
import {
  glibStress,
  memoryCosts,
  memStress,
  opfs,
  opfsReadOnly,
  opsFrom,
  poolExhausted,
  runScenarios,
  scenarios,
  threadCrash,
  workerMemory,
  type Env,
  type Scenario,
} from "../shared/scenarios.ts";

// A spinning page gives up on a reply after SPIN_LIMIT_MS, twenty times the
// longest any request has taken when nothing waits for the page (Chromium's
// spawn(4), some 50 ms), then waits for it without holding its thread, up to
// REPLY_TIMEOUT_MS more: a reply that comes only then needed the page's main
// thread.
const SPIN_LIMIT_MS = 1_000;
const REPLY_TIMEOUT_MS = 30_000;

// ES2024's Atomics.waitAsync(), which the DOM library this targets doesn't
// declare.
const { waitAsync } = Atomics as unknown as {
  waitAsync(
    typedArray: Int32Array,
    index: number,
    value: number,
    timeout: number,
  ): { async: false; value: string } | { async: true; value: Promise<string> };
};

const byName = new Map<string, Scenario>(
  [
    ...scenarios,
    poolExhausted,
    opfs,
    opfsReadOnly,
    threadCrash,
    memStress,
    glibStress,
    memoryCosts,
    workerMemory,
  ].map((scenario) => [scenario.name, scenario]),
);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const fetchOk = async (url: URL): Promise<Response> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
};

const mainThreadAtomicsWait = (): string => {
  try {
    return `returned ${Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 1, 0)}`;
  } catch (error) {
    return `throws ${String(error)}`;
  }
};

// A file at the root of the origin's private file system, which the host's
// OPFS backend mounts.
const readOpfs = async (name: string): Promise<string | null> => {
  const root = await navigator.storage.getDirectory();
  try {
    return await (await (await root.getFileHandle(name)).getFile()).text();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError")
      return null;
    throw error;
  }
};

// The harness's measure of the browser's processes, which it exposes to the
// page, and, where the browser has it, the page's own measure of its memory
// and its Workers'.
const sampleMemory = async (): Promise<Record<string, number>> => {
  const { ibusWebSampleMemory } = globalThis as unknown as {
    ibusWebSampleMemory?: () => Promise<Record<string, number>>;
  };
  const sample = (await ibusWebSampleMemory?.()) ?? {};
  const { measureUserAgentSpecificMemory } = performance as unknown as {
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
  };
  // Chromium declares it but refuses it without a flag, as its headless
  // shell does.
  if (measureUserAgentSpecificMemory !== undefined) {
    const measured = await Promise.race([
      measureUserAgentSpecificMemory.call(performance),
      sleep(60_000).then(() => null),
    ]).catch(() => null);
    if (measured !== null)
      sample.userAgentSpecific = Math.round(measured.bytes / 2 ** 20);
  }
  return sample;
};

const runSpike = async (spec: PageRunSpec): Promise<PageRunReport> => {
  if (!crossOriginIsolated)
    throw new Error("the page is not cross-origin isolated");
  const selected = spec.scenarios.map((name) => {
    const scenario = byName.get(name);
    if (scenario === undefined) throw new Error(`no scenario ${name}`);
    return scenario;
  });
  const runtimeUrl = new URL(spec.runtimeUrl, location.href);
  const [wasm, sides] = await Promise.all([
    WebAssembly.compileStreaming(
      fetchOk(new URL(runtimeUrl.href.replace(/\.js$/, ".wasm"))),
    ),
    Promise.all(
      spec.sideUrls.map(async (url): Promise<SideModule> => {
        const resolved = new URL(url, location.href);
        return {
          name: resolved.pathname.replace(/^.*\/|\.wasm$/g, ""),
          bytes: await (await fetchOk(resolved)).arrayBuffer(),
        };
      }),
    ),
  ]);

  const control = createControl();
  const worker = new Worker(new URL("../worker/host.js", import.meta.url), {
    type: "module",
    name: "ibus-web-host",
  });
  const init: HostInit<WebAssembly.Module> = {
    runtimeUrl: runtimeUrl.href,
    poolLowWater: spec.poolLowWater,
    wasm,
    memory: spec.memory,
    control,
    sides,
    storage:
      spec.opfsMount === undefined
        ? { kind: "memory" }
        : { kind: "opfs", mountPath: spec.opfsMount },
    wait: spec.wait,
    constants: spec.constants,
  };
  try {
    const { startupMs, features, messages } = await startHost(worker, init);
    // The page's main thread can't block, so a call either spins until the
    // reply or waits for it asynchronously.
    const waitFree = async (
      words: Int32Array,
      index: number,
      value: number,
      ms: number,
    ): Promise<void> => {
      const result = waitAsync(words, index, value, ms);
      if (result.async) await result.value;
    };
    const client = blockingClient(
      control,
      messages,
      spec.pageWait === "spin"
        ? {
            now: () => performance.now(),
            sleep,
            block: () => {},
            replyTimeoutMs: SPIN_LIMIT_MS,
            lateReply: { wait: waitFree, ms: REPLY_TIMEOUT_MS },
          }
        : {
            now: () => performance.now(),
            sleep,
            block: waitFree,
            replyTimeoutMs: REPLY_TIMEOUT_MS,
          },
    );
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const env: Env = {
      now: () => performance.now(),
      sleep,
      utf8: (text) => encoder.encode(text),
      decode: (bytes) => decoder.decode(bytes),
      errno: spec.errno,
      ops: opsFrom(spec.constants),
      poolSize: spec.poolSize,
      plannedThreads: spec.plannedThreads,
      engineThreads: spec.engineThreads,
      glibThreads: spec.glibThreads,
      poolLowWater: spec.poolLowWater,
      fsyncPaths: [
        "/tmp/fsync-memory.txt",
        ...(spec.opfsMount === undefined
          ? []
          : [`${spec.opfsMount}/fsync-opfs.txt`]),
      ],
      pendingLimitMs: spec.pendingLimitMs,
      ...(spec.wakeMaxMs === undefined ? {} : { wakeMaxMs: spec.wakeMaxMs }),
      ...(spec.opfsMount === undefined
        ? {}
        : { persistent: { dir: spec.opfsMount, read: readOpfs } }),
      ...(spec.stress === undefined ? {} : { stress: spec.stress }),
      ...(spec.sampleMemory === true ? { sampleMemory } : {}),
    };
    const results = await runScenarios(client, env, selected);
    // The host's own messages, such as a crash report, arrive only once
    // this thread's event loop runs.
    await sleep(100);
    return {
      userAgent: navigator.userAgent,
      mainThreadAtomicsWait: mainThreadAtomicsWait(),
      pageClockStepUs: clockStepUs(() => performance.now()),
      startupMs,
      features,
      results,
      messages,
    };
  } finally {
    worker.terminate();
  }
};

Object.assign(globalThis, { runSpike });
