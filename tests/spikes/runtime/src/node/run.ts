// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node run.js --runtime RUNTIME_JS --sides DIR --errno ERRNO_JSON
//                    --pool N [--compare]
//
// Runs the runtime spike's scenarios against the Worker host in Node, posting
// requests over the control buffer as a page would. The host sleeps in the
// runtime (ibusweb_wait). With --compare, for the record, the scenarios run
// again on a host that waits asynchronously while idle, and those that tell
// the options apart on one that sleeps in Atomics.wait() on the control
// buffer. Exits 1 if any scenario of the first host fails.

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  controlViews,
  createControl,
  encodeRequest,
  postRequest,
  State,
  takeReply,
  Word,
  type HostInit,
  type HostMessage,
  type WaitMode,
} from "../shared/control.ts";
import {
  runScenarios,
  scenarios,
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
    pool: { type: "string" },
    compare: { type: "boolean", default: false },
  },
});
if (
  args.runtime === undefined ||
  args.sides === undefined ||
  args.errno === undefined ||
  args.pool === undefined
) {
  throw new Error("--runtime, --sides, --errno and --pool are required");
}
const runtimeJs = args.runtime;
const sidesDir = args.sides;
const poolSize = Number(args.pool);

// Node's types leave WebAssembly to the DOM library, which Node code here
// doesn't load; this is the one call made, and the module only passes
// through to the host.
declare const WebAssembly: { compile(bytes: Uint8Array): Promise<object> };

const REPLY_TIMEOUT_MS = 30_000;

// Blocks this thread until the host replies, as the page's synchronous
// keystroke path would spin.
const syncClient = (control: SharedArrayBuffer): Client => {
  const views = controlViews(control);
  return {
    call: (opcode, payload) => {
      if (Atomics.load(views.words, Word.state) === State.crashed) {
        return Promise.reject(new Error("the host has crashed"));
      }
      postRequest(views, encodeRequest(opcode, payload));
      const deadline = performance.now() + REPLY_TIMEOUT_MS;
      for (;;) {
        const state = Atomics.load(views.words, Word.state);
        if (state === State.reply) return Promise.resolve(takeReply(views));
        if (state === State.crashed)
          return Promise.reject(
            new Error(`the host crashed on opcode ${opcode}`),
          );
        const left = deadline - performance.now();
        if (left <= 0)
          return Promise.reject(
            new Error(`no reply to opcode ${opcode} in ${REPLY_TIMEOUT_MS} ms`),
          );
        Atomics.wait(views.words, Word.state, state, left);
      }
    },
  };
};

interface Host {
  worker: BrowserWorker;
  client: Client;
  startupMs: number;
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
  const ready = new Promise<number>((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      const message = data as HostMessage;
      if (message.type === "ready") resolve(message.startupMs);
      else if (message.type === "error")
        reject(new Error(`host: ${message.message}`));
      else messages.push(message);
    };
    worker.onerror = ({ message }) => reject(new Error(`host: ${message}`));
  });
  const init: HostInit<object> = { ...base, control, wait };
  worker.postMessage(init);
  return {
    worker,
    client: syncClient(control),
    startupMs: await ready,
    messages,
  };
};

const format = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

// Waits a moment first: the host's own messages, such as a crash report,
// arrive only once this thread's event loop runs.
const report = async (
  label: string,
  host: Host,
  results: readonly Result[],
): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log(`== ${label} (startup ${host.startupMs.toFixed(0)} ms)`);
  for (const { name, pass, criterion, measurements, error } of results) {
    console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${criterion}`);
    for (const [key, value] of Object.entries(measurements))
      console.log(`    ${key}: ${format(value)}`);
    if (error !== undefined) console.log(`    error: ${error}`);
  }
  for (const message of host.messages)
    console.log(
      `    host ${message.type}: ${"message" in message ? message.message : ""}`,
    );
  console.log(
    `RESULTS ${JSON.stringify({ label, startupMs: host.startupMs, results })}`,
  );
};

const errno = JSON.parse(await readFile(args.errno, "utf8")) as Record<
  string,
  number
>;
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
  poolSize,
  fsyncPaths: ["/tmp/fsync-memory.txt", `${mountPath}/fsync-node.txt`],
  pendingLimitMs,
});

const base = {
  runtimeUrl: pathToFileURL(runtimeJs).href,
  wasm,
  sides,
  storage: { kind: "node", hostPath: hostDir, mountPath },
} as const;

let failed = false;
try {
  const host = await startHost("runtime", base);
  const results = await runScenarios(host.client, env(10_000));
  await report("option 2: the host sleeps in ibusweb_wait()", host, results);
  failed =
    results.length !== scenarios.length ||
    results.some((result) => !result.pass);
  host.worker.terminate();

  if (args.compare) {
    const idle = await startHost("runtime-async", base);
    await report(
      "for comparison: the idle host waits with Atomics.waitAsync(), its event loop running",
      idle,
      await runScenarios(idle.client, env(10_000)),
    );
    idle.worker.terminate();

    const option1 = await startHost("control", base);
    const names = new Set([
      "dispatch",
      "cross-thread-wake",
      "deadline",
      "sync-proxied",
    ]);
    await report(
      "option 1, for comparison: the host sleeps in Atomics.wait() on the control buffer",
      option1,
      await runScenarios(
        option1.client,
        env(3_000),
        scenarios.filter(({ name }) => names.has(name)),
      ),
    );
    option1.worker.terminate();
  }
} finally {
  await rm(hostDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
