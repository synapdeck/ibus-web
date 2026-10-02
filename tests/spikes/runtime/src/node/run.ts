// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node run.js --runtime RUNTIME_JS --sides DIR --errno ERRNO_JSON
//                    --constants CONSTANTS_JSON --pool N --planned-threads N
//                    --engine-threads N --glib-threads N --pool-low-water N
//                    --memory BYTES [--compare]
//
// Runs the runtime spike's scenarios against the Worker host in Node, posting
// requests over the control buffer as a page would. The host makes the
// runtime's memory, of BYTES that never grow. The host sleeps in the
// runtime (ibusweb_wait); then a host of its own runs the crash scenario,
// and another one heap-full. Hosts given a memory the runtime can't take
// must refuse to load.
// With --compare, for the record, the scenarios run again on a host that
// waits asynchronously while idle, and those that tell the wake paths apart
// on one that sleeps in Atomics.wait() on the control buffer. Exits 1 if any
// scenario of the first two hosts fails.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { reportLines } from "../shared/report.ts";
import {
  heapFull,
  opsFrom,
  runScenarios,
  scenarios,
  threadCrash,
  type Env,
  type Result,
} from "../shared/scenarios.ts";
import {
  compileRuntime,
  readConstants,
  readJson,
  readSides,
  startNodeHost as startHost,
  type NodeHost as Host,
} from "./host.ts";

const { values: args } = parseArgs({
  options: {
    runtime: { type: "string" },
    sides: { type: "string" },
    errno: { type: "string" },
    constants: { type: "string" },
    pool: { type: "string" },
    "planned-threads": { type: "string" },
    "engine-threads": { type: "string" },
    "glib-threads": { type: "string" },
    "pool-low-water": { type: "string" },
    memory: { type: "string" },
    compare: { type: "boolean", default: false },
  },
});
if (
  args.runtime === undefined ||
  args.sides === undefined ||
  args.errno === undefined ||
  args.constants === undefined ||
  args.pool === undefined ||
  args["planned-threads"] === undefined ||
  args["engine-threads"] === undefined ||
  args["glib-threads"] === undefined ||
  args["pool-low-water"] === undefined ||
  args.memory === undefined
) {
  throw new Error(
    "--runtime, --sides, --errno, --constants, --pool, --planned-threads, --engine-threads, --glib-threads, --pool-low-water and --memory are required",
  );
}
const runtimeJs = args.runtime;
const sidesDir = args.sides;
const poolSize = Number(args.pool);
const plannedThreads = Number(args["planned-threads"]);
const engineThreads = Number(args["engine-threads"]);
const glibThreads = Number(args["glib-threads"]);
const poolLowWater = Number(args["pool-low-water"]);
const memoryBytes = Number(args.memory);

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

const errno = await readJson<Record<string, number>>(args.errno);
const constants = await readConstants(args.constants);
const ops = opsFrom(constants);
const wasm = await compileRuntime(runtimeJs);
const sides = await readSides(sidesDir);
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
  plannedThreads,
  engineThreads,
  glibThreads,
  poolLowWater,
  fsyncPaths: ["/tmp/fsync-memory.txt", `${mountPath}/fsync-node.txt`],
  pendingLimitMs,
});

const base = {
  runtimeUrl: pathToFileURL(runtimeJs).href,
  wasm,
  memory: { initial: memoryBytes, maximum: memoryBytes },
  sides,
  storage: { kind: "node", hostPath: hostDir, mountPath },
  constants,
  poolLowWater,
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

  const full = await startHost("runtime", base);
  const heap = await runScenarios(full.client, env(10_000), [heapFull]);
  await report("runtime, on a host of its own", full, heap);
  failed ||= !passed(heap, 1);
  full.worker.terminate();

  // A size that isn't whole pages and one below the least the runtime takes.
  console.log("memory the runtime can't take:");
  for (const bytes of [
    constants.memory.minimum + 1,
    constants.memory.minimum - 65536,
  ]) {
    const refusal = await startHost("runtime", {
      ...base,
      memory: { initial: bytes, maximum: bytes },
    }).then(
      ({ worker }) => {
        worker.terminate();
        return null;
      },
      (error: unknown) => String(error),
    );
    const refused = refusal?.includes(`memory ${bytes}: `) ?? false;
    console.log(
      `  ${refused ? "PASS" : "FAIL"} ${bytes}: ${refusal ?? "loaded"}`,
    );
    failed ||= !refused;
  }

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
