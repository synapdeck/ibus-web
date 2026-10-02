// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node run.js --runtime RUNTIME_JS --sides DIR --errno ERRNO_JSON
//                    --constants CONSTANTS_JSON --pool N --planned-threads N
//                    --engine-threads N --glib-threads N --pool-low-water N
//                    --memory BYTES --install-data DIR [--compare]
//
// Runs the runtime spike's scenarios against the Worker host in Node, posting
// requests over the control buffer as a page would. The host makes the
// runtime's memory, of BYTES that never grow. The host sleeps in the
// runtime (ibusweb_wait) and mounts a WasmFS Node backend over a temporary
// directory at the engine's directory, installing the engine's data, DIR's
// tree.tar, served over HTTP, into it; then a host of its own runs the crash
// scenario, another one heap-full, and another, told to mount the engine's
// IndexedDB database, which Node lacks, storage-fallback. The install
// scenarios follow, each starting hosts of its own on a directory of its
// own. Hosts given a memory the runtime can't take must refuse to load.
// With --compare, for the record, the scenarios run again on a host that
// waits asynchronously while idle, and those that tell the wake paths apart
// on one that sleeps in Atomics.wait() on the control buffer, and every
// cross-thread wake must take at most 20 ms. Exits 1 if any scenario of the
// first hosts fails.

import { mkdirSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "./server.ts";
import {
  encodeComponent,
  engineDataBytes,
  engineDir,
  SPIKE_ENGINE,
  withData,
  type EngineManifest,
  type HostMessage,
  type Mount,
  type TestData,
} from "../shared/control.ts";
import { installScenarios, runInstallScenarios, type InstallHarness } from "../shared/install.ts";
import { reportLines } from "../shared/report.ts";
import {
  heapFull,
  opsFrom,
  runScenarios,
  scenarios,
  storageFallback,
  threadCrash,
  type Env,
  type Result,
} from "../shared/scenarios.ts";
import {
  compileRuntime,
  launchNodeHost,
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
    "install-data": { type: "string" },
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
  args.memory === undefined ||
  args["install-data"] === undefined
) {
  throw new Error(
    "--runtime, --sides, --errno, --constants, --pool, --planned-threads, --engine-threads, --glib-threads, --pool-low-water, --memory and --install-data are required",
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
// Run by hand, on a quiet machine, every cross-thread wake is held to this.
const STRICT_WAKE_MAX_MS = 20;

// Waits a moment first: the host's own messages, such as a crash report,
// arrive only once this thread's event loop runs.
const report = async (label: string, host: Host, results: readonly Result[]): Promise<void> => {
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
const installData = args["install-data"];
const testData = await readJson<TestData>(join(installData, "tree.json"));
// Hosts fetch the engine's data as a browser's would.
const server = await serve(join(installData, "tree.json"), {
  "/data/": installData,
});
const dataUrl = `${server.origin}/data/${testData.archive}`;
const engine = withData(SPIKE_ENGINE, testData, dataUrl);
const dir = engineDir(engine);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const env = (pendingLimitMs: number, host: Host, mount: Mount = "node"): Env => ({
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
  fsyncPaths: ["/tmp/fsync-memory.txt", `${dir}/fsync-node.txt`],
  pendingLimitMs,
  memoryMaximum: constants.memory.maximum,
  memoryBytes,
  engine: { dir, mount, dataBytes: engineDataBytes(engine) },
  hostMessages: () => host.messages,
  ...(args.compare ? { wakeMaxMs: STRICT_WAKE_MAX_MS } : {}),
});

const base = {
  runtimeUrl: pathToFileURL(runtimeJs).href,
  wasm,
  memory: { initial: memoryBytes, maximum: memoryBytes },
  sides,
  engine,
  storage: { kind: "node", hostPath: hostDir },
  constants,
  poolLowWater,
} as const;

const passed = (results: readonly Result[], expected: number): boolean =>
  results.length === expected && results.every((result) => result.pass);

let failed = false;
try {
  const host = await startHost("runtime", base);
  const results = await runScenarios(host.client, env(10_000, host));
  await report("runtime: the host sleeps in ibusweb_wait(), woken through the relay for the page", host, results);
  failed = !passed(results, scenarios.length);
  host.worker.terminate();

  const crashing = await startHost("runtime", base);
  const crash = await runScenarios(crashing.client, env(10_000, crashing), [threadCrash]);
  await report("runtime, on a host of its own", crashing, crash);
  failed ||= !passed(crash, 1);
  crashing.worker.terminate();

  const full = await startHost("runtime", base);
  const heap = await runScenarios(full.client, env(10_000, full), [heapFull]);
  await report("runtime, on a host of its own", full, heap);
  failed ||= !passed(heap, 1);
  full.worker.terminate();

  const memoryOnly = await startHost("runtime", {
    ...base,
    storage: { kind: "browser", withoutIndexedDB: true },
  });
  const fallback = await runScenarios(memoryOnly.client, env(10_000, memoryOnly, "memory"), [storageFallback]);
  await report("runtime, on a host of its own told to mount IndexedDB", memoryOnly, fallback);
  failed ||= !passed(fallback, 1);
  memoryOnly.worker.terminate();

  const installsDir = join(hostDir, "installs");
  const installs: InstallHarness = {
    env: env(10_000, memoryOnly),
    data: testData,
    dataUrl,
    upgradeUrl: `${server.origin}/data/${testData.upgrade.archive}`,
    // Node's Web Locks are shared by the process's threads, so the hosts'
    // Workers' locks are this thread's to request too.
    lockFree: (name) => navigator.locks.request(name, { ifAvailable: true }, (lock) => lock !== null),
    // A version's directory, its marker, or both.
    versions: async (installed) => [
      ...new Set(
        (await readdir(join(installsDir, installed.name, "data")).catch(() => [] as string[])).map((name) =>
          name.replace(/\.(installed|marking)$/, ""),
        ),
      ),
    ],
    tearMarker: (installed) =>
      writeFile(join(installsDir, installed.name, "data", `${encodeComponent(installed.version)}.installed`), '{"vers'),
    start: (installed: EngineManifest, options = {}) => {
      const hostPath = join(installsDir, installed.name);
      mkdirSync(hostPath, { recursive: true });
      const messages: HostMessage[] = [];
      const { worker, host } = launchNodeHost(
        "runtime",
        {
          ...base,
          engine: installed,
          storage: { kind: "node", hostPath },
          ...options,
        },
        messages,
      );
      return {
        messages,
        ready: host.then(({ client }) => client),
        terminate: () => worker.terminate(),
      };
    },
  };
  const installResults = await runInstallScenarios(installs);
  for (const line of reportLines(
    "install: hosts sharing an engine's directory, each scenario its own",
    0,
    installResults,
    [],
  ))
    console.log(line);
  failed ||= !passed(installResults, installScenarios.length);

  // A size that isn't whole pages and one below the least the runtime takes.
  console.log("memory the runtime can't take:");
  for (const bytes of [constants.memory.minimum + 1, constants.memory.minimum - 65536]) {
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
    console.log(`  ${refused ? "PASS" : "FAIL"} ${bytes}: ${refusal ?? "loaded"}`);
    failed ||= !refused;
  }

  if (args.compare) {
    const idle = await startHost("runtime-async", base);
    await report(
      "for comparison: the idle host waits with Atomics.waitAsync(), its event loop running",
      idle,
      await runScenarios(idle.client, env(10_000, idle)),
    );
    idle.worker.terminate();

    const relayless = await startHost("control", base);
    const names = new Set(["dispatch", "cold-wake", "cross-thread-wake", "deadline", "sync-proxied"]);
    await report(
      "for comparison, relay-less on the request path: the host sleeps in Atomics.wait() " +
        "on the control buffer's wake word, which the page bumps",
      relayless,
      await runScenarios(
        relayless.client,
        env(3_000, relayless),
        scenarios.filter(({ name }) => names.has(name)),
      ),
    );
    relayless.worker.terminate();
  }
} finally {
  await server.close();
  await rm(hostDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
