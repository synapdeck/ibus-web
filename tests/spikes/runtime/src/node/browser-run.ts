// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node browser-run.js --runtime RUNTIME_JS --sides DIR --errno ERRNO_JSON
//                            --constants CONSTANTS_JSON --pool N
//                            --planned-threads N --engine-threads N
//                            --glib-threads N --pool-low-water N
//                            --memory BYTES --install-data DIR
//                            [--browser chromium|firefox]... [--scenario NAME]...
//                            [--compare | --measure --chunk-size BYTES...]
//
// Runs the runtime spike's scenarios in browsers, headless, through
// Playwright: a page served with cross-origin isolation starts the Worker
// host by URL and plays the page's part over the control buffer. Each host
// runs in a browser context of its own, so the origin's storage starts empty
// every time. Each host makes the runtime's memory, of BYTES that never
// grow, and mounts the engine's IndexedDB database at the engine's
// directory, installing the engine's data, DIR's tree.tar, there. In each
// browser the host sleeps in the runtime and runs every scenario; a host of
// its own runs the crash scenario, another storage-closed, and another, in
// which indexedDB.open() throws, storage-fallback; then the install
// scenarios start hosts of their own, from one page, sharing the context's
// storage and locks as tabs of one origin do. With --compare, for the record, the same with the page
// waiting asynchronously, the idle host that waits asynchronously and the
// relay-less one follow, and every cross-thread wake must take at most
// 20 ms. With --measure, instead, for the record, storage-costs runs alone
// on a host of its own for each chunk size, the page spinning for each
// reply and then idle, waiting asynchronously: the engine is named so that
// a runtime linked for measurement creates its user data's database with
// chunks of that size.
//
// Prints each host's results, then a table per host with a column per
// browser. Exits 1 if a scenario of the hosts before the comparisons fails
// in any browser other than as a known failure below describes, if a known
// failure passes, or, run without --browser and --scenario, if one isn't
// run.

import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import type { Browser } from "playwright";
import { join } from "node:path";
import type { BuildConstants, TestData, WaitMode } from "../shared/control.ts";
import { installScenarios } from "../shared/install.ts";
import { reportLines, type PageRunReport, type PageRunSpec } from "../shared/report.ts";
import { poolExhausted, scenarios, storageClosed, storageFallback, type Result } from "../shared/scenarios.ts";
import { browsersNamed, launch, launchError, launchPersistent, servePage } from "./browsers.ts";

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
    browser: { type: "string", multiple: true },
    // Runs only these scenarios, where a host would run them.
    scenario: { type: "string", multiple: true },
    compare: { type: "boolean", default: false },
    measure: { type: "boolean", default: false },
    "chunk-size": { type: "string", multiple: true },
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
const memoryBytes = Number(args.memory);

const browserNames = browsersNamed(args.browser);

// Generous against the scenarios' own limits, so that a hung host fails its
// run rather than the whole check's time limit.
const RUN_TIMEOUT_MS = 180_000;
// Run by hand, on a quiet machine, every cross-thread wake is held to this.
const STRICT_WAKE_MAX_MS = 20;

const errno = JSON.parse(await readFile(args.errno, "utf8")) as Record<string, number>;
const constants = JSON.parse(await readFile(args.constants, "utf8")) as BuildConstants;
const sideNames = (await readdir(args.sides)).filter((file) => file.endsWith(".wasm")).sort();

const installData = args["install-data"];
const testData = JSON.parse(await readFile(join(installData, "tree.json"), "utf8")) as TestData;

const server = await servePage({
  "/runtime/": dirname(args.runtime),
  "/sides/": args.sides,
  "/data/": installData,
});

interface Run {
  // Short, for the known failures below.
  id: string;
  label: string;
  // Whether a failure here fails the harness.
  counts: boolean;
  // Whether its scenarios are install scenarios.
  install?: boolean;
  wait: WaitMode;
  pageWait: PageRunSpec["pageWait"];
  scenarios: string[];
  pendingLimitMs: number;
  storage: PageRunSpec["storage"];
  engineName?: string;
  // Whether the run's storage is on disk, in a browser of its own, rather
  // than in an off-the-record context of the shared one, whose IndexedDB
  // Chromium keeps in memory.
  persistent?: boolean;
}

const names = (list: readonly { name: string }[]): string[] => list.map(({ name }) => name);

const allScenarios = [...names(scenarios), poolExhausted.name];

const runs: Run[] = [
  {
    id: "runtime",
    label: "runtime: the host sleeps in ibusweb_wait(), woken through the relay; the page spins for each reply",
    counts: true,
    wait: "runtime",
    pageWait: "spin",
    scenarios: allScenarios,
    pendingLimitMs: 10_000,
    storage: "browser",
  },
  {
    id: "crash",
    label: "runtime, on a host of its own",
    counts: true,
    wait: "runtime",
    pageWait: "spin",
    scenarios: ["thread-crash"],
    pendingLimitMs: 10_000,
    storage: "browser",
  },
  {
    id: "closed",
    label: "runtime, on a host of its own whose database the page opens at a newer version",
    counts: true,
    wait: "runtime",
    pageWait: "spin",
    scenarios: [storageClosed.name],
    pendingLimitMs: 10_000,
    storage: "browser",
  },
  {
    id: "fallback",
    label: "runtime, on a host of its own in which indexedDB.open() throws, as in an opaque origin",
    counts: true,
    wait: "runtime",
    pageWait: "spin",
    scenarios: [storageFallback.name],
    pendingLimitMs: 10_000,
    storage: "browser-without-indexeddb",
  },
  {
    id: "install",
    label:
      "install: hosts started from one page share the origin's storage and locks, each scenario on an engine of its own",
    counts: true,
    install: true,
    wait: "runtime",
    pageWait: "spin",
    scenarios: names(installScenarios),
    pendingLimitMs: 10_000,
    storage: "browser",
  },
];
if (args.compare)
  runs.push(
    {
      id: "page-async",
      label:
        "for comparison: runtime, the page waiting for each reply with Atomics.waitAsync(), its event loop running",
      counts: false,
      wait: "runtime",
      pageWait: "async",
      scenarios: allScenarios,
      pendingLimitMs: 10_000,
      storage: "browser",
    },
    {
      id: "runtime-async",
      label: "for comparison: the idle host waits with Atomics.waitAsync(), its event loop running",
      counts: false,
      wait: "runtime-async",
      pageWait: "spin",
      scenarios: allScenarios,
      pendingLimitMs: 10_000,
      storage: "browser",
    },
    {
      id: "control",
      label:
        "for comparison, relay-less on the request path: the host sleeps in Atomics.wait() " +
        "on the control buffer's wake word, which the page bumps",
      counts: false,
      wait: "control",
      pageWait: "spin",
      scenarios: ["dispatch", "cold-wake", "cross-thread-wake", "deadline", "sync-proxied"],
      pendingLimitMs: 3_000,
      storage: "browser",
    },
  );

// Named so that the measurement link's backend gives the database of the
// engine's user data chunks of this many bytes.
const chunkEngine = (bytes: number): string => `spike-chunk-${bytes}`;

if (args.measure) {
  const sizes = (args["chunk-size"] ?? []).map(Number);
  if (sizes.length === 0 || sizes.some((bytes) => !(bytes > 0)))
    throw new Error("--measure takes one or more --chunk-size BYTES");
  runs.splice(
    0,
    runs.length,
    ...sizes.flatMap((bytes) =>
      (["spin", "async"] as const).map((pageWait): Run => ({
        id: `measure-${bytes}-${pageWait}`,
        label: `for the record: chunks of ${bytes / 1024} KiB, the page ${pageWait === "spin" ? "spinning for each reply" : "idle, waiting for each reply asynchronously"}`,
        counts: false,
        wait: "runtime",
        pageWait,
        scenarios: ["storage-costs"],
        pendingLimitMs: 10_000,
        storage: "browser",
        engineName: chunkEngine(bytes),
        persistent: true,
      })),
    ),
  );
}

if (args.scenario !== undefined) {
  const only = new Set(args.scenario);
  for (const run of runs) run.scenarios = run.scenarios.filter((name) => only.has(name));
  runs.splice(0, runs.length, ...runs.filter((run) => run.scenarios.length > 0));
}

interface Outcome {
  browser: string;
  run: Run;
  results: Result[];
  // Why the run produced no results at all.
  error?: string;
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no result in ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

// Browser and console output goes to stderr, apart from the results.
const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

// Firefox warns that the runtime's exception-handling instructions are
// deprecated once for every Worker that instantiates it, hundreds of times
// a run, so the warnings are counted instead of printed.
const DEPRECATED_TRY = "WebAssembly exception handling 'try' instruction is deprecated";

// The bytes of the files in which the browser keeps IndexedDB under the
// profile: Chromium's IndexedDB directory, Firefox's idb directories.
const indexedDBBytes = async (profile: string): Promise<number> => {
  let bytes = 0;
  for (const entry of await readdir(profile, {
    recursive: true,
    withFileTypes: true,
  })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile() && /\/(IndexedDB|idb)\//.test(path)) bytes += (await stat(path)).size;
  }
  return bytes;
};

const runOne = async (browserName: string, browser: Browser, run: Run): Promise<Outcome> => {
  const profile = run.persistent ? await mkdtemp(join(tmpdir(), "ibus-web-profile-")) : undefined;
  const context = profile === undefined ? await browser.newContext() : await launchPersistent(browserName, profile);
  let deprecatedTry = 0;
  try {
    if (profile !== undefined) await context.exposeFunction("ibusWebIndexedDBBytes", () => indexedDBBytes(profile));
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.text().includes(DEPRECATED_TRY)) deprecatedTry++;
      else log(`[${browserName} console.${message.type()}] ${message.text()}`);
    });
    page.on("pageerror", (error) => log(`[${browserName} pageerror] ${error.message}`));
    await page.goto(`${server.origin}/`);
    const isolated = await page.evaluate(
      () => (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
    );
    if (!isolated)
      return {
        browser: browserName,
        run,
        results: [],
        error: "crossOriginIsolated is not true",
      };
    await page.waitForFunction(() => "runSpike" in globalThis);
    const spec: PageRunSpec = {
      runtimeUrl: `/runtime/${basename(args.runtime!)}`,
      sideUrls: sideNames.map((file) => `/sides/${file}`),
      wait: run.wait,
      scenarios: run.scenarios,
      ...(run.install === true ? { install: true } : {}),
      data: testData,
      dataUrl: `/data/${testData.archive}`,
      constants,
      errno,
      poolSize: Number(args.pool),
      plannedThreads: Number(args["planned-threads"]),
      engineThreads: Number(args["engine-threads"]),
      glibThreads: Number(args["glib-threads"]),
      poolLowWater: Number(args["pool-low-water"]),
      pendingLimitMs: run.pendingLimitMs,
      pageWait: run.pageWait,
      memory: { initial: memoryBytes, maximum: memoryBytes },
      storage: run.storage,
      ...(run.engineName === undefined ? {} : { engineName: run.engineName }),
      ...(args.compare ? { wakeMaxMs: STRICT_WAKE_MAX_MS } : {}),
    };
    const report = await withTimeout(
      page.evaluate(
        (spec) =>
          (
            globalThis as unknown as {
              runSpike(spec: PageRunSpec): Promise<PageRunReport>;
            }
          ).runSpike(spec),
        spec,
      ),
      RUN_TIMEOUT_MS,
    );
    const lines = reportLines(`${browserName}, ${run.label}`, report.startupMs, report.results, report.messages);
    lines.splice(
      1,
      0,
      `    browser: ${report.userAgent}`,
      `    host features: ${JSON.stringify(report.features)}`,
      `    page: performance.now() step ${report.pageClockStepUs} µs; Atomics.wait() ${report.mainThreadAtomicsWait}`,
    );
    for (const line of lines) console.log(line);
    return { browser: browserName, run, results: report.results };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`== ${browserName}, ${run.label}\nFAIL: ${message}`);
    return { browser: browserName, run, results: [], error: message };
  } finally {
    await context.close();
    if (deprecatedTry > 0) log(`[${browserName}] ${deprecatedTry} warnings that the 'try' instruction is deprecated`);
    if (profile !== undefined) {
      console.log(
        `    IndexedDB on disk once ${browserName} closed: ${((await indexedDBBytes(profile)) / 1024).toFixed(1)} KiB`,
      );
      await rm(profile, { recursive: true, force: true });
    }
  }
};

// The ways the browsers are known to fail scenarios in runs whose failures
// fail the harness, by "browser run scenario". Each fails a criterion that
// holds under Node, so it is reported as it is instead of loosening the
// criterion. A failure counts as known only if `matches` recognises its cause; a known failure
// that passes, or fails some other way, fails the harness.
interface KnownFailure {
  why: string;
  matches(result: Result): boolean;
}

const knownFailures: Readonly<Record<string, KnownFailure>> = {};

const failureKey = (browser: string, run: Run, scenario: string): string => `${browser} ${run.id} ${scenario}`;

const resultOf = (outcome: Outcome, name: string): Result | undefined =>
  outcome.results.find((result) => result.name === name);

// One scenario's numbers, short enough for a table cell.
const headline = ({ name, pass, measurements: m }: Result): string => {
  if (pass)
    switch (name) {
      case "dispatch":
        return `p50 ${m.p50Us} µs, p99 ${m.p99Us} µs, max ${m.maxUs} µs; batch mean ${m.batchMeanUs} µs (${String(m.batchMeanRangeUs)}); asleep ${m.requestsWhileAsleep}`;
      case "cold-wake":
        return `p50 ${m.p50Us} µs, p99 ${m.p99Us} µs, max ${m.maxUs} µs, mean ${m.meanUs} µs; asleep ${m.requestsWhileAsleep}`;
      case "cross-thread-wake":
        return `ε p50 ${m.p50Ms} ms, max ${m.maxMs} ms`;
      case "deadline":
        return `worst deviation ${m.worstDeviationMs} ms`;
    }
  return Object.entries(m)
    .map(([key, value]) =>
      key === "lateReplies" && Array.isArray(value)
        ? `${value.length} late (${value[0]})`
        : `${key} ${JSON.stringify(value)}`,
    )
    .join(", ");
};

const table = (outcomes: readonly Outcome[]): string[] => {
  const lines: string[] = [];
  for (const run of runs) {
    const columns = outcomes.filter((outcome) => outcome.run === run);
    lines.push(
      "",
      `## ${run.label}`,
      "",
      `| Scenario | ${columns.map(({ browser }) => browser).join(" | ")} |`,
      `| --- |${" --- |".repeat(columns.length)}`,
    );
    for (const name of run.scenarios) {
      const cells = columns.map((outcome) => {
        const result = resultOf(outcome, name);
        if (result === undefined) return outcome.error ?? "not run";
        const known = run.counts ? knownFailures[failureKey(outcome.browser, run, name)] : undefined;
        const status = result.pass
          ? known === undefined
            ? "PASS"
            : "PASS, expected to fail"
          : known === undefined
            ? "FAIL"
            : known.matches(result)
              ? "FAIL, known"
              : "FAIL, not as known";
        return `${status}: ${result.error ?? headline(result)}`;
      });
      lines.push(`| ${name} | ${cells.join(" | ")} |`);
    }
  }
  return lines;
};

const outcomes: Outcome[] = [];
try {
  for (const name of browserNames) {
    let browser: Browser;
    try {
      browser = await launch(name);
    } catch (error) {
      // The other browser still runs, and the tables show why this didn't.
      const message = launchError(error);
      console.log(`== ${name}\nFAIL: ${message}`);
      for (const run of runs) outcomes.push({ browser: name, run, results: [], error: message });
      continue;
    }
    try {
      for (const run of runs) outcomes.push(await runOne(name, browser, run));
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
for (const line of table(outcomes)) console.log(line);

const unexpected: string[] = [];
const known: string[] = [];
const evaluated = new Set<string>();
for (const outcome of outcomes) {
  if (!outcome.run.counts) continue;
  for (const name of outcome.run.scenarios) {
    const key = failureKey(outcome.browser, outcome.run, name);
    const result = resultOf(outcome, name);
    if (result !== undefined) evaluated.add(key);
    const knownFailure = knownFailures[key];
    if (result?.pass === true) {
      if (knownFailure !== undefined) unexpected.push(`${key}: passed, but is listed as a known failure`);
    } else if (knownFailure === undefined) unexpected.push(`${key}: failed`);
    else if (result === undefined || !knownFailure.matches(result))
      unexpected.push(`${key}: failed, but not as the known failure does`);
    else known.push(`${key}: ${knownFailure.why}`);
  }
}
if (args.browser === undefined && args.scenario === undefined)
  for (const key of Object.keys(knownFailures))
    if (!evaluated.has(key)) unexpected.push(`${key}: listed as a known failure, but not run`);
console.log("");
for (const line of known) console.log(`KNOWN FAILURE ${line}`);
for (const line of unexpected) console.log(`UNEXPECTED ${line}`);
process.exit(unexpected.length > 0 ? 1 : 0);
