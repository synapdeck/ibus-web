// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node browser-memory.js --sides DIR --errno ERRNO_JSON
//                               --constants CONSTANTS_JSON --pool N
//                               --planned-threads N --engine-threads N
//                               --glib-threads N --pool-low-water N
//                               --variant NAME=RUNTIME_JS,INITIAL,MAXIMUM...
//                               [--browser chromium|firefox]...
//                               [--workload NAME]... [--runs N] [--parallel N]
//                               [--threads N] [--rounds N] [--iterations N]
//                               [--costs-only NAME]...
//
// The memory scenarios in headless browsers, as memory.js runs them under
// Node: each run a page of its own, in a browser context of its own, whose
// host makes the variant's memory and runs one workload; --parallel pages
// at once per browser. Then each variant runs memory-costs and dispatch
// once (a --costs-only variant runs only these), and the first runs
// worker-memory, measuring the browser's processes
// from here and, where the browser has it, with
// performance.measureUserAgentSpecificMemory().
//
// A variant whose first three runs in a browser all fail to start is taken
// as unsupported there and not run further. Prints a line per configuration,
// then MEMORY and a line of JSON. Exits 1 if a fixed-memory run fails.

import { readdir, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import type { Browser } from "playwright";
import type { BuildConstants } from "../shared/control.ts";
import type { PageRunReport, PageRunSpec } from "../shared/report.ts";
import type { Result } from "../shared/scenarios.ts";
import { browsersNamed, launch, launchError, servePage } from "./browsers.ts";

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
    browser: { type: "string", multiple: true },
    workload: { type: "string", multiple: true },
    runs: { type: "string", default: "50" },
    parallel: { type: "string", default: "2" },
    threads: { type: "string", default: "100" },
    rounds: { type: "string", default: "24" },
    iterations: { type: "string", default: "10000" },
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
  if (match === null)
    throw new Error(`--variant ${spec}: not NAME=RUNTIME_JS,INITIAL,MAXIMUM`);
  const [, name, runtime, initial, maximum] = match;
  return {
    name: name!,
    runtime: runtime!,
    initial: Number(initial),
    maximum: Number(maximum),
  };
});
const grows = ({ initial, maximum }: Variant): boolean => maximum > initial;
const workloads = args.workload ?? ["mem-stress", "glib-stress"];
const runs = Number(args.runs);
const costsOnly = new Set(args["costs-only"] ?? []);
const parallel = Number(args.parallel);

const RUN_TIMEOUT_MS = 240_000;
const MiB = 2 ** 20;

const errno = JSON.parse(await readFile(args.errno!, "utf8")) as Record<
  string,
  number
>;
const constants = JSON.parse(
  await readFile(args.constants!, "utf8"),
) as BuildConstants;
const sideNames = (await readdir(args.sides!))
  .filter((file) => file.endsWith(".wasm"))
  .sort();

const server = await servePage({
  "/sides/": args.sides!,
  ...Object.fromEntries(
    variants.map(({ name, runtime }) => [
      `/runtime-${name}/`,
      dirname(runtime),
    ]),
  ),
});

// The browser's processes, this one's descendants, as /proc has them: their
// resident and proportional set sizes, in MiB.
const sampleProcesses = async (): Promise<Record<string, number>> => {
  const parents = new Map<number, number>();
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      // The command name, in parentheses, may itself hold spaces.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parents.set(Number(entry), Number(fields[1]));
    } catch {
      // Gone since the listing.
    }
  }
  const tree = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of parents)
      if (tree.has(parent) && !tree.has(pid)) {
        tree.add(pid);
        grew = true;
      }
  }
  tree.delete(process.pid);
  let rss = 0;
  let pss = 0;
  for (const pid of tree) {
    try {
      const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
      rss += Number(/^Rss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0);
      pss += Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0);
    } catch {
      // Gone, or not ours to read.
    }
  }
  return {
    processRss: Math.round((rss * 1024) / MiB),
    processPss: Math.round((pss * 1024) / MiB),
  };
};

interface RunOutcome {
  report: PageRunReport | null;
  error?: string;
  // The page's console errors and uncaught errors, where a trapping
  // thread's error shows in a browser.
  console: string[];
}

const runPage = async (
  browser: Browser,
  variant: Variant,
  scenarios: string[],
  sampleMemory = false,
): Promise<RunOutcome> => {
  const context = await browser.newContext();
  const logs: string[] = [];
  try {
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") logs.push(message.text());
    });
    page.on("pageerror", (error) => logs.push(error.message));
    if (sampleMemory)
      await page.exposeFunction("ibusWebSampleMemory", sampleProcesses);
    await page.goto(`${server.origin}/`);
    await page.waitForFunction(() => "runSpike" in globalThis);
    const spec: PageRunSpec = {
      runtimeUrl: `/runtime-${variant.name}/${basename(variant.runtime)}`,
      sideUrls: sideNames.map((file) => `/sides/${file}`),
      wait: "runtime",
      scenarios,
      constants,
      errno,
      poolSize: Number(args.pool),
      plannedThreads: Number(args["planned-threads"]),
      engineThreads: Number(args["engine-threads"]),
      glibThreads: Number(args["glib-threads"]),
      poolLowWater: Number(args["pool-low-water"]),
      pendingLimitMs: 120_000,
      pageWait: "async",
      memory: { initial: variant.initial, maximum: variant.maximum },
      stress: {
        threads: Number(args.threads),
        rounds: Number(args.rounds),
        iterations: Number(args.iterations),
      },
      sampleMemory,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = await Promise.race([
      page.evaluate(
        (spec) =>
          (
            globalThis as unknown as {
              runSpike(spec: PageRunSpec): Promise<PageRunReport>;
            }
          ).runSpike(spec),
        spec,
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no result in ${RUN_TIMEOUT_MS} ms`)),
          RUN_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    return { report, console: logs };
  } catch (error) {
    return {
      report: null,
      error:
        error instanceof Error ? error.message.split("\n")[0] : String(error),
      console: logs,
    };
  } finally {
    await context.close();
  }
};

interface Tally {
  browser: string;
  variant: string;
  workload: string;
  grows: boolean;
  runs: number;
  passed: number;
  traps: number;
  otherFailures: number;
  noResult: number;
  unsupported?: string;
  sites: Record<string, number>;
  failures: string[];
  elapsedMs: number[];
  memoryMiB: number[];
  breakMiB: number[];
}

// Where a trapping thread was: the error and the innermost frames of its
// stack, as the host reported it.
const trapSite = (text: string): string => {
  const lines = text.split("\n");
  const error =
    lines.find((line) => /RuntimeError|memory access/.test(line)) ?? lines[0]!;
  const frames = lines
    .filter((line) => /^\s*at |@|wasm-function/.test(line))
    .slice(0, 4)
    .map((line) => line.trim());
  return [error.trim(), ...frames].join(" < ").slice(0, 400);
};

const record = (tally: Tally, outcome: RunOutcome): void => {
  tally.runs++;
  const result = outcome.report?.results[0];
  if (outcome.report === null || result === undefined) {
    tally.noResult++;
    tally.failures.push(
      `${outcome.error ?? "no result"}; ${outcome.console.slice(-2).join(" | ")}`,
    );
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
  const crashed = outcome.report.messages.find(
    (message) => message.type === "crashed",
  );
  const crash =
    crashed !== undefined && "message" in crashed ? crashed.message : "";
  const evidence = [crash, ...outcome.console].join("\n");
  if (
    /RuntimeError|memory access out of bounds|out of bounds/i.test(evidence)
  ) {
    tally.traps++;
    const source =
      [crash, ...outcome.console].find((text) =>
        /RuntimeError|out of bounds/i.test(text),
      ) ?? evidence;
    const site = trapSite(source);
    tally.sites[site] = (tally.sites[site] ?? 0) + 1;
  } else {
    tally.otherFailures++;
    tally.failures.push(
      `${result.error ?? JSON.stringify(result.measurements)}; ${crash}`,
    );
  }
};

const range = (values: readonly number[]): string =>
  values.length === 0 ? "-" : `${Math.min(...values)}–${Math.max(...values)}`;

const summary = (tally: Tally): string =>
  `${tally.browser} ${tally.variant} ${tally.workload}: ${tally.runs} runs, ${tally.passed} passed, ` +
  `${tally.traps} trapped, ${tally.otherFailures} failed otherwise, ${tally.noResult} without a result` +
  (tally.unsupported === undefined
    ? ""
    : ` (unsupported: ${tally.unsupported})`) +
  `; elapsed ${range(tally.elapsedMs)} ms, memory at the end ${range(tally.memoryMiB)} MiB, ` +
  `heap's break at the end ${range(tally.breakMiB)} MiB`;

const pool = async (
  jobs: readonly (() => Promise<void>)[],
  width: number,
): Promise<void> => {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) await jobs[next++]!();
  };
  await Promise.all(Array.from({ length: width }, worker));
};

const tallies: Tally[] = [];
const costs: Record<string, Record<string, Result[] | string>> = {};
const workerCost: Record<string, Result[] | string> = {};
const show = (label: string, outcome: RunOutcome): void => {
  for (const result of outcome.report?.results ?? [])
    console.log(
      `${label} ${result.name}: ${result.pass ? "PASS" : "FAIL"} ${JSON.stringify(result.measurements)}` +
        (result.error === undefined ? "" : ` ${result.error}`),
    );
  if (outcome.report === null)
    console.log(`${label}: no result: ${outcome.error}`);
};

try {
  for (const browserName of browsersNamed(args.browser)) {
    let browser: Browser;
    try {
      browser = await launch(browserName);
    } catch (error) {
      console.log(`${browserName}: ${launchError(error)}`);
      continue;
    }
    try {
      for (const variant of variants)
        for (const workload of costsOnly.has(variant.name) ? [] : workloads) {
          const tally: Tally = {
            browser: browserName,
            variant: variant.name,
            workload,
            grows: grows(variant),
            runs: 0,
            passed: 0,
            traps: 0,
            otherFailures: 0,
            noResult: 0,
            sites: {},
            failures: [],
            elapsedMs: [],
            memoryMiB: [],
            breakMiB: [],
          };
          tallies.push(tally);
          const started = performance.now();
          await pool(
            Array.from({ length: runs }, () => async () => {
              if (tally.unsupported !== undefined) return;
              record(tally, await runPage(browser, variant, [workload]));
              if (tally.runs >= 3 && tally.noResult === tally.runs)
                tally.unsupported = tally.failures[0] ?? "no result";
            }),
            parallel,
          );
          console.log(
            `${summary(tally)}; ${((performance.now() - started) / 1000).toFixed(0)} s`,
          );
          for (const [site, count] of Object.entries(tally.sites))
            console.log(`    ${count}× ${site}`);
          for (const failure of tally.failures.slice(0, 3))
            console.log(`    failure: ${failure}`);
        }
      costs[browserName] = {};
      for (const variant of variants) {
        const outcome = await runPage(browser, variant, [
          "memory-costs",
          "dispatch",
        ]);
        costs[browserName][variant.name] =
          outcome.report?.results ?? outcome.error ?? "none";
        show(`${browserName} ${variant.name}`, outcome);
      }
      const measured = await runPage(
        browser,
        variants[0]!,
        ["worker-memory"],
        true,
      );
      workerCost[browserName] =
        measured.report?.results ?? measured.error ?? "none";
      show(`${browserName} ${variants[0]!.name}`, measured);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}

console.log(`MEMORY ${JSON.stringify({ tallies, costs, workerCost })}`);
const failed = tallies.some(
  (tally) => !tally.grows && tally.passed < tally.runs,
);
process.exit(failed ? 1 : 0);
