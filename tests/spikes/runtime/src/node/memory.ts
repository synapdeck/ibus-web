// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node memory.js --sides DIR --errno ERRNO_JSON --constants CONSTANTS_JSON
//                       --pool N --planned-threads N --engine-threads N
//                       --glib-threads N --pool-low-water N
//                       --variant NAME=RUNTIME_JS,INITIAL,MAXIMUM...
//                       [--workload NAME]... [--runs N] [--parallel N]
//                       [--threads N] [--rounds N] [--iterations N]
//                       [--costs] [--costs-only NAME]... [--worker-memory]
//
// The memory scenarios under Node. A variant is a runtime and the memory its
// host makes for it, in bytes: one whose maximum is above its initial size
// can grow. Each run is a host of its own in a process of its own, so that
// its memory starts small, running one workload (mem-stress, glib-stress;
// both by default); runs go --parallel at a time, but for --costs-only
// variants. With --costs, each variant then runs memory-costs and dispatch
// once; with --worker-memory, the first
// variant runs worker-memory, measuring this process.
//
// Prints a line per configuration with its runs, passes and traps (grouped
// by where the trapping thread was), then MEMORY and a line of JSON. Exits
// 1 if a fixed-memory run fails or a run produces no result.

import { spawn } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { SPIKE_ENGINE, type HostInit } from "../shared/control.ts";
import {
  dispatch,
  glibStress,
  memoryCosts,
  memStress,
  opsFrom,
  outOfMemoryAbort,
  runScenarios,
  workerMemory,
  type Env,
  type Result,
  type Scenario,
} from "../shared/scenarios.ts";
import { compileRuntime, readConstants, readJson, readSides, startNodeHost } from "./host.ts";

const { values: args } = parseArgs({
  options: {
    sides: { type: "string" },
    errno: { type: "string" },
    constants: { type: "string" },
    pool: { type: "string" },
    "planned-threads": { type: "string" },
    "engine-threads": { type: "string" },
    "glib-threads": { type: "string" },
    "pool-low-water": { type: "string" },
    variant: { type: "string", multiple: true },
    // Variants that only run the costs, not the workloads.
    "costs-only": { type: "string", multiple: true },
    workload: { type: "string", multiple: true },
    runs: { type: "string", default: "300" },
    parallel: { type: "string", default: "6" },
    threads: { type: "string", default: "100" },
    rounds: { type: "string", default: "24" },
    iterations: { type: "string", default: "10000" },
    costs: { type: "boolean", default: false },
    "worker-memory": { type: "boolean", default: false },
    // One run, in this process: the variant's name and a scenario.
    child: { type: "string" },
  },
});
const required = [
  "sides",
  "errno",
  "constants",
  "pool",
  "planned-threads",
  "engine-threads",
  "glib-threads",
  "pool-low-water",
] as const;
const missing = required.filter((name) => args[name] === undefined);
if (missing.length > 0 || args.variant === undefined)
  throw new Error(`--${[...missing, "variant"].join(", --")} are required`);

interface Variant {
  name: string;
  runtime: string;
  initial: number;
  maximum: number;
}

const variants: Variant[] = args.variant.map((spec) => {
  const match = /^([^=]+)=([^,]+),(\d+),(\d+)$/.exec(spec);
  if (match === null) throw new Error(`--variant ${spec}: not NAME=RUNTIME_JS,INITIAL,MAXIMUM`);
  const [, name, runtime, initial, maximum] = match;
  return {
    name: name!,
    runtime: runtime!,
    initial: Number(initial),
    maximum: Number(maximum),
  };
});
const grows = ({ initial, maximum }: Variant): boolean => maximum > initial;

const workloads: Readonly<Record<string, Scenario>> = {
  [memStress.name]: memStress,
  [glibStress.name]: glibStress,
};
const byName: Readonly<Record<string, Scenario>> = {
  ...workloads,
  [memoryCosts.name]: memoryCosts,
  [dispatch.name]: dispatch,
  [workerMemory.name]: workerMemory,
};

// A thread that traps takes the whole run, so a child that hangs instead is
// killed after this long.
const RUN_TIMEOUT_MS = 180_000;

const MiB = 2 ** 20;

// What a child prints about its run, on a line of its own after RESULT.
interface RunReport {
  results: Result[];
  // The host's report of why it crashed.
  crash: string | null;
  startupMs: number;
}

const runChild = async (variant: Variant, names: string[]): Promise<void> => {
  const constants = await readConstants(args.constants!);
  const host = await startNodeHost("runtime", {
    runtimeUrl: pathToFileURL(variant.runtime).href,
    wasm: await compileRuntime(variant.runtime),
    memory: { initial: variant.initial, maximum: variant.maximum },
    sides: await readSides(args.sides!),
    engine: SPIKE_ENGINE,
    storage: { kind: "none" },
    constants,
    poolLowWater: Number(args["pool-low-water"]),
  } satisfies Omit<HostInit<object>, "control" | "wait">);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const env: Env = {
    now: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    utf8: (text) => encoder.encode(text),
    decode: (bytes) => decoder.decode(bytes),
    errno: await readJson<Record<string, number>>(args.errno!),
    ops: opsFrom(constants),
    poolSize: Number(args.pool),
    plannedThreads: Number(args["planned-threads"]),
    engineThreads: Number(args["engine-threads"]),
    glibThreads: Number(args["glib-threads"]),
    poolLowWater: Number(args["pool-low-water"]),
    fsyncPaths: [],
    pendingLimitMs: 120_000,
    stress: {
      threads: Number(args.threads),
      rounds: Number(args.rounds),
      iterations: Number(args.iterations),
    },
    sampleMemory: () => {
      // Lets the Workers' own collections settle first.
      (globalThis as { gc?: () => void }).gc?.();
      return Promise.resolve({
        rss: Math.round(process.memoryUsage.rss() / MiB),
      });
    },
  };
  const selected = names.map((name) => {
    const scenario = byName[name];
    if (scenario === undefined) throw new Error(`no scenario ${name}`);
    return scenario;
  });
  const results = await runScenarios(host.client, env, selected);
  const failed = results.some(({ pass }) => !pass);
  const report: RunReport = {
    results,
    crash: failed ? await host.client.crashReport(2000) : null,
    startupMs: host.startupMs,
  };
  console.log(`RESULT ${JSON.stringify(report)}`);
  host.worker.terminate();
  process.exit(0);
};

// The options a child needs, as given to this process.
const childArgs = (variant: Variant, names: string[]): string[] => [
  ...required.flatMap((name) => [`--${name}`, args[name]!]),
  "--variant",
  `${variant.name}=${variant.runtime},${variant.initial},${variant.maximum}`,
  "--threads",
  args.threads!,
  "--rounds",
  args.rounds!,
  "--iterations",
  args.iterations!,
  "--child",
  [variant.name, ...names].join(","),
];

interface Outcome {
  report: RunReport | null;
  // Why there is no report: a timeout, or the child's exit.
  failure?: string;
  stderr: string;
}

const spawnChild = (variant: Variant, names: string[], nodeFlags: string[] = []): Promise<Outcome> =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [...nodeFlags, new URL(import.meta.url).pathname, ...childArgs(variant, names)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((text) => text.startsWith("RESULT "));
      resolve(
        line === undefined
          ? {
              report: null,
              failure:
                signal === "SIGKILL"
                  ? `no result in ${RUN_TIMEOUT_MS} ms`
                  : `exited ${code ?? signal} without a result`,
              stderr,
            }
          : {
              report: JSON.parse(line.slice("RESULT ".length)) as RunReport,
              stderr,
            },
      );
    });
  });

// Where a trapping thread was: the error and the innermost frames of its
// stack, without the addresses that differ between builds.
const trapSite = (text: string): string => {
  const lines = text.split("\n");
  const error = lines.find((line) => /RuntimeError|out of bounds|Error:/.test(line)) ?? "";
  const frames = lines
    .filter((line) => /^\s*at /.test(line))
    .slice(0, 4)
    .map((line) => line.trim().replace(/^at /, ""));
  return [error.trim(), ...frames].join(" < ");
};

interface Tally {
  variant: string;
  workload: string;
  grows: boolean;
  runs: number;
  passed: number;
  // Runs that Emscripten aborted for a heap that couldn't hold an
  // allocation, and runs with a thread that trapped otherwise.
  outOfMemory: number;
  traps: number;
  // Runs that failed some other way, and runs with no result.
  otherFailures: number;
  noResult: number;
  sites: Record<string, number>;
  failures: string[];
  // Each passing run's measurements, for the ranges.
  elapsedMs: number[];
  memoryMiB: number[];
  breakMiB: number[];
}

const tallyOf = (variant: Variant, workload: string): Tally => ({
  variant: variant.name,
  workload,
  grows: grows(variant),
  runs: 0,
  passed: 0,
  outOfMemory: 0,
  traps: 0,
  otherFailures: 0,
  noResult: 0,
  sites: {},
  failures: [],
  elapsedMs: [],
  memoryMiB: [],
  breakMiB: [],
});

const record = (tally: Tally, outcome: Outcome): void => {
  tally.runs++;
  const result = outcome.report?.results[0];
  if (outcome.report === null || result === undefined) {
    tally.noResult++;
    tally.failures.push(`${outcome.failure ?? "no result"}: ${outcome.stderr.slice(-500)}`);
    return;
  }
  if (result.pass) {
    tally.passed++;
    const { elapsedMs, memoryMiB, breakMiB } = result.measurements;
    if (typeof elapsedMs === "number") tally.elapsedMs.push(elapsedMs);
    if (Array.isArray(memoryMiB)) tally.memoryMiB.push(Number(memoryMiB[1]));
    if (typeof breakMiB === "number") tally.breakMiB.push(breakMiB);
    return;
  }
  const crash = outcome.report.crash ?? "";
  const evidence = `${crash}\n${outcome.stderr}`;
  const trapped = /RuntimeError|memory access out of bounds/;
  if (outOfMemoryAbort(evidence)) {
    tally.outOfMemory++;
    tally.failures.push(`aborted out of memory, by Emscripten rather than a trap: ${crash.split("\n")[0]}`);
  } else if (trapped.test(evidence)) {
    tally.traps++;
    const site = trapSite(trapped.test(crash) ? crash : outcome.stderr);
    tally.sites[site] = (tally.sites[site] ?? 0) + 1;
  } else {
    tally.otherFailures++;
    tally.failures.push(`${result.error ?? JSON.stringify(result.measurements)}; ${crash}`);
  }
};

const range = (values: readonly number[]): string =>
  values.length === 0 ? "-" : `${Math.min(...values)}–${Math.max(...values)}`;

const summary = (tally: Tally): string =>
  `${tally.variant} ${tally.workload}: ${tally.runs} runs, ${tally.passed} passed, ` +
  `${tally.outOfMemory} aborted out of memory, ${tally.traps} trapped otherwise, ` +
  `${tally.otherFailures} failed otherwise, ${tally.noResult} without a result; ` +
  `elapsed ${range(tally.elapsedMs)} ms, memory at the end ${range(tally.memoryMiB)} MiB, ` +
  `heap's break at the end ${range(tally.breakMiB)} MiB`;

// Runs each job, parallel at a time.
const pool = async <T>(jobs: readonly (() => Promise<T>)[], parallel: number): Promise<T[]> => {
  const results: T[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await jobs[index]!();
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return results;
};

if (args.child !== undefined) {
  const [name, ...names] = args.child.split(",");
  const variant = variants.find((each) => each.name === name);
  if (variant === undefined) throw new Error(`no variant ${name}`);
  await runChild(variant, names);
} else {
  const runs = Number(args.runs);
  const parallel = Number(args.parallel);
  const names = args.workload ?? Object.keys(workloads);
  const tallies: Tally[] = [];
  const costsOnly = new Set(args["costs-only"] ?? []);
  for (const variant of variants)
    for (const workload of costsOnly.has(variant.name) ? [] : names) {
      if (!(workload in workloads)) throw new Error(`no workload ${workload}`);
      const tally = tallyOf(variant, workload);
      tallies.push(tally);
      const started = performance.now();
      await pool(
        Array.from({ length: runs }, () => async () => record(tally, await spawnChild(variant, [workload]))),
        parallel,
      );
      console.log(`${summary(tally)}; ${((performance.now() - started) / 1000).toFixed(0)} s`);
      for (const [site, count] of Object.entries(tally.sites)) console.log(`    ${count}× ${site}`);
      for (const failure of tally.failures.slice(0, 3)) console.log(`    failure: ${failure}`);
    }

  const costs: Record<string, Result[] | string> = {};
  if (args.costs)
    for (const variant of variants) {
      const outcome = await spawnChild(variant, [memoryCosts.name, dispatch.name]);
      costs[variant.name] = outcome.report?.results ?? outcome.failure ?? "none";
      for (const result of outcome.report?.results ?? [])
        console.log(
          `${variant.name} ${result.name}: ${result.pass ? "PASS" : "FAIL"} ${JSON.stringify(result.measurements)}${result.error === undefined ? "" : ` ${result.error}`}`,
        );
    }

  let workerCost: Result[] | string | undefined;
  if (args["worker-memory"]) {
    const outcome = await spawnChild(variants[0]!, [workerMemory.name], ["--expose-gc"]);
    workerCost = outcome.report?.results ?? outcome.failure ?? "none";
    for (const result of outcome.report?.results ?? [])
      console.log(
        `${variants[0]!.name} ${result.name}: ${result.pass ? "PASS" : "FAIL"} ${JSON.stringify(result.measurements)}${result.error === undefined ? "" : ` ${result.error}`}`,
      );
  }

  console.log(`MEMORY ${JSON.stringify({ node: process.version, tallies, costs, workerCost })}`);
  const failed =
    tallies.some((tally) => tally.noResult > 0 || (!tally.grows && tally.passed < tally.runs)) ||
    Object.values(costs).some((results) => typeof results === "string" || results.some(({ pass }) => !pass)) ||
    (workerCost !== undefined && (typeof workerCost === "string" || workerCost.some(({ pass }) => !pass)));
  process.exit(failed ? 1 : 0);
}
