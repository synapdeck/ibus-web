// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node run.js --runtime RUNTIME_JS --sides DIR --errno ERRNO_JSON
//                    --constants CONSTANTS_JSON --pool N [--compare]
//
// Runs the runtime spike's scenarios against the Worker host in Node, posting
// requests over the control buffer as a page would. The host sleeps in the
// runtime (ibusweb_wait); then a host of its own runs the crash scenario.
// With --compare, for the record, the scenarios run again on a host that
// waits asynchronously while idle, and those that tell the wake paths apart
// on one that sleeps in Atomics.wait() on the control buffer. Exits 1 if any
// scenario of the first two hosts fails.

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { blockingClient } from "../shared/client.ts";
import {
  createControl,
  type BuildConstants,
  type HostFeatures,
  type HostInit,
  type HostMessage,
  type WaitMode,
} from "../shared/control.ts";
import { reportLines } from "../shared/report.ts";
import {
  opsFrom,
  runScenarios,
  scenarios,
  threadCrash,
  type Client,
  type Env,
  type Result,
} from "../shared/scenarios.ts";
import { BrowserWorker } from "./worker-adapter.ts";

const { values: args } = parseArgs({
  options: {
    runtime: { type: "string" },
    sides: { type: "string" },
    errno: { type: "string" },
    constants: { type: "string" },
    pool: { type: "string" },
    compare: { type: "boolean", default: false },
  },
});
if (
  args.runtime === undefined ||
  args.sides === undefined ||
  args.errno === undefined ||
  args.constants === undefined ||
  args.pool === undefined
) {
  throw new Error(
    "--runtime, --sides, --errno, --constants and --pool are required",
  );
}
const runtimeJs = args.runtime;
const sidesDir = args.sides;
const poolSize = Number(args.pool);

// Node's types leave WebAssembly to the DOM library, which Node code here
// doesn't load; this is the one call made, and the module only passes
// through to the host.
declare const WebAssembly: { compile(bytes: Uint8Array): Promise<object> };

const REPLY_TIMEOUT_MS = 30_000;

interface Host {
  worker: BrowserWorker;
  client: Client;
  startupMs: number;
  features: HostFeatures;
  // Messages after "ready", such as a crash report.
  messages: HostMessage[];
}

const startHost = async (
  wait: WaitMode,
  base: Omit<HostInit<object>, "control" | "wait">,
): Promise<Host> => {
  const control = createControl();
  const worker = new BrowserWorker(
    new URL("../worker/host.js", import.meta.url),
  );
  const messages: HostMessage[] = [];
  let started = false;
  const ready = new Promise<{ startupMs: number; features: HostFeatures }>(
    (resolve, reject) => {
      worker.onmessage = ({ data }) => {
        const message = data as HostMessage;
        if (message.type === "ready") {
          started = true;
          resolve(message);
        } else if (message.type === "error")
          reject(new Error(`host: ${message.message}`));
        else messages.push(message);
      };
      worker.onerror = ({ message }) => {
        if (started) messages.push({ type: "error", message });
        else reject(new Error(`host: ${message}`));
      };
    },
  );
  const init: HostInit<object> = { ...base, control, wait };
  worker.postMessage(init);
  const { startupMs, features } = await ready;
  return {
    worker,
    // Blocks this thread until the host replies, as the page's synchronous
    // keystroke path would spin.
    client: blockingClient(control, messages, {
      now: () => performance.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      block: (words, index, value, ms) => {
        Atomics.wait(words, index, value, ms);
      },
      replyTimeoutMs: REPLY_TIMEOUT_MS,
    }),
    startupMs,
    features,
    messages,
  };
};

// Waits a moment first: the host's own messages, such as a crash report,
// arrive only once this thread's event loop runs.
const report = async (
  label: string,
  host: Host,
  results: readonly Result[],
): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const lines = reportLines(label, host.startupMs, results, host.messages);
  lines.splice(1, 0, `    host features: ${JSON.stringify(host.features)}`);
  for (const line of lines) console.log(line);
};

const errno = JSON.parse(await readFile(args.errno, "utf8")) as Record<
  string,
  number
>;
const constants = JSON.parse(
  await readFile(args.constants, "utf8"),
) as BuildConstants;
const ops = opsFrom(constants);
const wasm = await WebAssembly.compile(
  await readFile(join(runtimeJs, "..", "ibus-runtime.wasm")),
);
const sides = await Promise.all(
  (await readdir(sidesDir))
    .filter((file) => file.endsWith(".wasm"))
    .sort()
    .map(async (file) => {
      const bytes = await readFile(join(sidesDir, file));
      return {
        name: basename(file, ".wasm"),
        bytes: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      };
    }),
);
const hostDir = await mkdtemp(join(tmpdir(), "ibus-web-spike-"));
const mountPath = "/host";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const env = (pendingLimitMs: number): Env => ({
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  utf8: (text) => encoder.encode(text),
  decode: (bytes) => decoder.decode(bytes),
  errno,
  ops,
  poolSize,
  fsyncPaths: ["/tmp/fsync-memory.txt", `${mountPath}/fsync-node.txt`],
  pendingLimitMs,
});

const base = {
  runtimeUrl: pathToFileURL(runtimeJs).href,
  wasm,
  sides,
  storage: { kind: "node", hostPath: hostDir, mountPath },
  constants,
} as const;

const passed = (results: readonly Result[], expected: number): boolean =>
  results.length === expected && results.every((result) => result.pass);

let failed = false;
try {
  const host = await startHost("runtime", base);
  const results = await runScenarios(host.client, env(10_000));
  await report(
    "runtime: the host sleeps in ibusweb_wait(), woken through the relay for the page",
    host,
    results,
  );
  failed = !passed(results, scenarios.length);
  host.worker.terminate();

  const crashing = await startHost("runtime", base);
  const crash = await runScenarios(crashing.client, env(10_000), [threadCrash]);
  await report("runtime, on a host of its own", crashing, crash);
  failed ||= !passed(crash, 1);
  crashing.worker.terminate();

  if (args.compare) {
    const idle = await startHost("runtime-async", base);
    await report(
      "for comparison: the idle host waits with Atomics.waitAsync(), its event loop running",
      idle,
      await runScenarios(idle.client, env(10_000)),
    );
    idle.worker.terminate();

    const relayless = await startHost("control", base);
    const names = new Set([
      "dispatch",
      "cold-wake",
      "cross-thread-wake",
      "deadline",
      "sync-proxied",
    ]);
    await report(
      "for comparison, relay-less on the request path: the host sleeps in Atomics.wait() " +
        "on the control buffer's wake word, which the page bumps",
      relayless,
      await runScenarios(
        relayless.client,
        env(3_000),
        scenarios.filter(({ name }) => names.has(name)),
      ),
    );
    relayless.worker.terminate();
  }
} finally {
  await rm(hostDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
