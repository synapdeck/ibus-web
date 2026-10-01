// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node browser-run.js --runtime RUNTIME_JS --sides DIR --errno ERRNO_JSON
//                            --constants CONSTANTS_JSON --pool N
//                            [--browser chromium|firefox]... [--scenario NAME]...
//                            [--compare]
//
// Runs the runtime spike's scenarios in browsers, headless, through
// Playwright: a page served with cross-origin isolation starts the Worker
// host by URL and plays the page's part over the control buffer. Each host
// runs in a browser context of its own, so the origin's private file system
// starts empty every time. In each browser the host sleeps in the runtime
// and runs every scenario, a host of its own with OPFS mounted runs the
// storage scenarios on it, and another the crash scenario; with --compare, for the record, the idle host that waits
// asynchronously and the relay-less one follow. Prints each host's results,
// then a table per host with a column per browser. Exits 1 if any scenario
// of the first three hosts fails in any browser, other than the known
// failures listed below, or if one of those passes.

import { readdir, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, firefox, type Browser, type BrowserType } from "playwright";
import type { BuildConstants, WaitMode } from "../shared/control.ts";
import {
  reportLines,
  type PageRunReport,
  type PageRunSpec,
} from "../shared/report.ts";
import { scenarios, type Result } from "../shared/scenarios.ts";
import { serve } from "./server.ts";

const { values: args } = parseArgs({
  options: {
    runtime: { type: "string" },
    sides: { type: "string" },
    errno: { type: "string" },
    constants: { type: "string" },
    pool: { type: "string" },
    browser: { type: "string", multiple: true },
    // Runs only these scenarios, where a host would run them.
    scenario: { type: "string", multiple: true },
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

const browserTypes: Readonly<Record<string, BrowserType>> = {
  chromium,
  firefox,
};
const browserNames = args.browser ?? Object.keys(browserTypes);
for (const name of browserNames)
  if (!(name in browserTypes)) throw new Error(`no browser ${name}`);

// Generous against the scenarios' own limits, so that a hung host fails its
// run rather than the whole check's time limit.
const RUN_TIMEOUT_MS = 180_000;
const OPFS_MOUNT = "/engines/spike";

const errno = JSON.parse(await readFile(args.errno, "utf8")) as Record<
  string,
  number
>;
const constants = JSON.parse(
  await readFile(args.constants, "utf8"),
) as BuildConstants;
const sideNames = (await readdir(args.sides))
  .filter((file) => file.endsWith(".wasm"))
  .sort();

const dist = fileURLToPath(new URL("../", import.meta.url));
const server = await serve(
  fileURLToPath(new URL("../../src/page/index.html", import.meta.url)),
  {
    "/dist/": dist,
    "/runtime/": dirname(args.runtime),
    "/sides/": args.sides,
  },
);

// Playwright turns Chromium's own sandbox off unless asked; the harness
// runs it as a browser would.
const launch = (name: string): Promise<Browser> =>
  browserTypes[name]!.launch(
    name === "chromium"
      ? { headless: true, chromiumSandbox: true }
      : { headless: true },
  );

interface Run {
  // Short, for the known failures below.
  id: string;
  label: string;
  // Whether a failure here fails the harness.
  counts: boolean;
  wait: WaitMode;
  pageWait: PageRunSpec["pageWait"];
  scenarios: string[];
  pendingLimitMs: number;
  opfs: boolean;
}

const names = (list: readonly { name: string }[]): string[] =>
  list.map(({ name }) => name);

const opfsScenarios = ["cold-wake", "promise-proxied-fsync", "opfs"];

const runs: Run[] = [
  {
    id: "runtime",
    label:
      "runtime: the host sleeps in ibusweb_wait(), woken through the relay; the page spins for each reply",
    counts: true,
    wait: "runtime",
    pageWait: "spin",
    scenarios: names(scenarios),
    pendingLimitMs: 10_000,
    opfs: false,
  },
  {
    id: "runtime-opfs",
    label: `runtime, on a host of its own with OPFS mounted at ${OPFS_MOUNT}`,
    counts: true,
    wait: "runtime",
    pageWait: "spin",
    scenarios: opfsScenarios,
    pendingLimitMs: 10_000,
    opfs: true,
  },
  {
    id: "crash",
    label: "runtime, on a host of its own",
    counts: true,
    wait: "runtime",
    pageWait: "spin",
    scenarios: ["thread-crash"],
    pendingLimitMs: 10_000,
    opfs: false,
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
      scenarios: names(scenarios),
      pendingLimitMs: 10_000,
      opfs: false,
    },
    {
      id: "page-async-opfs",
      label: `for comparison: the same, on a host of its own with OPFS mounted at ${OPFS_MOUNT}`,
      counts: false,
      wait: "runtime",
      pageWait: "async",
      scenarios: opfsScenarios,
      pendingLimitMs: 10_000,
      opfs: true,
    },
    {
      id: "runtime-async",
      label:
        "for comparison: the idle host waits with Atomics.waitAsync(), its event loop running",
      counts: false,
      wait: "runtime-async",
      pageWait: "spin",
      scenarios: names(scenarios),
      pendingLimitMs: 10_000,
      opfs: false,
    },
    {
      id: "control",
      label:
        "for comparison, relay-less on the request path: the host sleeps in Atomics.wait() " +
        "on the control buffer's wake word, which the page bumps",
      counts: false,
      wait: "control",
      pageWait: "spin",
      scenarios: [
        "dispatch",
        "cold-wake",
        "cross-thread-wake",
        "deadline",
        "sync-proxied",
      ],
      pendingLimitMs: 3_000,
      opfs: false,
    },
  );

if (args.scenario !== undefined) {
  const only = new Set(args.scenario);
  for (const run of runs)
    run.scenarios = run.scenarios.filter((name) => only.has(name));
  runs.splice(
    0,
    runs.length,
    ...runs.filter((run) => run.scenarios.length > 0),
  );
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
    const timer = setTimeout(
      () => reject(new Error(`no result in ${ms} ms`)),
      ms,
    );
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

const runOne = async (
  browserName: string,
  browser: Browser,
  run: Run,
): Promise<Outcome> => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.on("console", (message) =>
      log(`[${browserName} console.${message.type()}] ${message.text()}`),
    );
    page.on("pageerror", (error) =>
      log(`[${browserName} pageerror] ${error.message}`),
    );
    await page.goto(`${server.origin}/`);
    const isolated = await page.evaluate(
      () =>
        (globalThis as { crossOriginIsolated?: boolean })
          .crossOriginIsolated === true,
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
      constants,
      errno,
      poolSize: Number(args.pool),
      pendingLimitMs: run.pendingLimitMs,
      pageWait: run.pageWait,
      ...(run.opfs ? { opfsMount: OPFS_MOUNT } : {}),
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
    const lines = reportLines(
      `${browserName}, ${run.label}`,
      report.startupMs,
      report.results,
      report.messages,
    );
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
  }
};

// Failures of the runs that count, by "browser run scenario", that the
// browsers are known to produce, with why. Each fails a criterion that holds
// under Node, so it is reported as it is instead of loosening the criterion;
// one that passes fails the harness too, so the list stays exact.
const knownFailures: Readonly<Record<string, string>> = {
  "chromium runtime thread-create-blocked":
    "Chromium starts a Worker only once the thread that created it returns to its event loop, " +
    "and the host, blocked in a pump or asleep in ibusweb_wait(), doesn't",
  "firefox runtime thread-create-blocked":
    "in Firefox, new Worker() on a Worker returns only once the page's main thread is free, " +
    "and the page spins for the reply",
  "firefox runtime-opfs opfs":
    "Firefox reads an OPFS file's Blob, as WasmFS reads a file opened read-only, only once " +
    "the page's main thread is free, and the page spins for the reply",
};

const failureKey = (browser: string, run: Run, scenario: string): string =>
  `${browser} ${run.id} ${scenario}`;

const resultOf = (outcome: Outcome, name: string): Result | undefined =>
  outcome.results.find((result) => result.name === name);

// One scenario's numbers, short enough for a table cell.
const headline = ({ name, pass, measurements: m }: Result): string => {
  if (pass)
    switch (name) {
      case "dispatch":
      case "cold-wake":
        return `p50 ${m.p50Us} µs, p99 ${m.p99Us} µs, max ${m.maxUs} µs; asleep ${m.requestsWhileAsleep}`;
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
        const known =
          run.counts && failureKey(outcome.browser, run, name) in knownFailures;
        const status = result.pass
          ? known
            ? "PASS, expected to fail"
            : "PASS"
          : known
            ? "FAIL, known"
            : "FAIL";
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
    const browser = await launch(name);
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
for (const outcome of outcomes) {
  if (!outcome.run.counts) continue;
  for (const name of outcome.run.scenarios) {
    const key = failureKey(outcome.browser, outcome.run, name);
    const failed = resultOf(outcome, name)?.pass !== true;
    const why = knownFailures[key];
    if (failed && why === undefined) unexpected.push(`${key}: failed`);
    else if (!failed && why !== undefined)
      unexpected.push(`${key}: passed, but is listed as a known failure`);
    else if (failed && why !== undefined) known.push(`${key}: ${why}`);
  }
}
console.log("");
for (const line of known) console.log(`KNOWN FAILURE ${line}`);
for (const line of unexpected) console.log(`UNEXPECTED ${line}`);
process.exit(unexpected.length > 0 ? 1 : 0);
