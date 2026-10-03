// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Counts the sync system calls (fsync, fdatasync, sync_file_range, syncfs)
// every process of a browser makes while a page runs rounds of IndexedDB
// write transactions with the default durability, each followed by nothing,
// by an empty strict transaction or by a strict one that puts a record back.
//
//   node measure.ts [--runs N] [--rounds N] [--profile-root DIR]
//                   [--out results.json] [--traces DIR]
//
// Needs strace (or IDB_SYNC_STRACE) and the environment the repository's
// browser checks run under: PLAYWRIGHT_BROWSERS_PATH naming nixpkgs'
// playwright-driver browsers.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { release, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium, firefox, type BrowserContext } from "playwright";

const here = import.meta.dirname;

const { values: options } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    rounds: { type: "string", default: "50" },
    "profile-root": { type: "string", default: tmpdir() },
    out: { type: "string" },
    traces: { type: "string" },
  },
});
const runs = Number(options.runs);
const rounds = Number(options.rounds);
const profileRoot = path.resolve(options["profile-root"]);

const browsers = {
  chromium: {
    type: chromium,
    executable: ["chromium_headless_shell-", "chrome-headless-shell-linux64/chrome-headless-shell"],
  },
  firefox: { type: firefox, executable: ["firefox-", "firefox/firefox"] },
} as const;
type BrowserName = keyof typeof browsers;

// "baseline" loads the page and opens no database, to show the browser's own
// syncs over a window as long as the others'.
const variants = ["baseline", "relaxed-only", "empty-strict", "put-strict"] as const;
type Variant = (typeof variants)[number];

// What page.html's script defines.
type PageApi = {
  openDatabase(): Promise<void>;
  measure(variant: Exclude<Variant, "baseline">, rounds: number): Promise<{ strictMeanMs: number }>;
};

const syscalls = ["fsync", "fdatasync", "sync_file_range", "syncfs"] as const;
type Counts = Partial<Record<(typeof syscalls)[number], number>>;

// Lets the database's creation, and anything the browser does once a page
// has loaded, sync before the window opens.
const settleMs = 1000;
const baselineWindowMs = 5000;
// Syncs that a relaxed commit defers land here, if they land before close.
const afterMs = 2000;

// Playwright's own lookup of the headless shell and Firefox, which the
// wrapper has to be given, isn't public.
const realExecutable = (name: BrowserName): string => {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsersPath === undefined) throw new Error("PLAYWRIGHT_BROWSERS_PATH is unset");
  const [prefix, relative] = browsers[name].executable;
  const directory = readdirSync(browsersPath).find((entry) => entry.startsWith(prefix));
  if (directory === undefined) throw new Error(`no ${prefix}* in ${browsersPath}`);
  return path.join(browsersPath, directory, relative);
};

const page = readFileSync(path.join(here, "page.html"));
const server = createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(page);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

// strace -ttt stamps each call with the wall clock in seconds, as Date.now()
// reads it; a call that blocks is logged once with "<unfinished ...>" and
// again, as "<... resumed>", which isn't counted.
const callPattern = /^\d+ (\d+\.\d+) (fsync|fdatasync|sync_file_range|syncfs)\(/;
const countCalls = (trace: string, from: number, to: number): Counts => {
  const counts: Counts = {};
  for (const line of trace.split("\n")) {
    const match = callPattern.exec(line);
    if (match === null) continue;
    const at = Number(match[1]) * 1000;
    if (at < from || at >= to) continue;
    const call = match[2] as (typeof syscalls)[number];
    counts[call] = (counts[call] ?? 0) + 1;
  }
  return counts;
};

type Run = {
  browser: BrowserName;
  browserVersion: string;
  variant: Variant;
  run: number;
  rounds: number;
  windowMs: number;
  strictMeanMs: number | null;
  syncs: { beforeWindow: Counts; window: Counts; afterWindow: Counts };
};

const measure = async (name: BrowserName, variant: Variant, run: number): Promise<Run> => {
  const profile = mkdtempSync(path.join(profileRoot, `idb-sync-${name}-`));
  const trace = `${profile}.strace`;
  let context: BrowserContext | undefined;
  try {
    const launched = Date.now();
    // A persistent context, because Chromium keeps an off-the-record
    // context's IndexedDB in memory.
    context = await browsers[name].type.launchPersistentContext(profile, {
      headless: true,
      executablePath: path.join(here, "strace-browser.sh"),
      env: { ...process.env, IDB_SYNC_BROWSER: realExecutable(name), IDB_SYNC_TRACE: trace },
      ...(name === "chromium" ? { chromiumSandbox: process.env.IBUS_WEB_CHROMIUM_SANDBOX === "1" } : {}),
    });
    const browserVersion = context.browser()?.version() ?? "unknown";
    const tab = await context.newPage();
    await tab.goto(origin);
    if (variant !== "baseline") await tab.evaluate(() => (globalThis as unknown as PageApi).openDatabase());
    await sleep(settleMs);
    const windowStart = Date.now();
    let strictMeanMs: number | null = null;
    if (variant === "baseline") {
      await sleep(baselineWindowMs);
    } else {
      const result = await tab.evaluate(
        ([variant, rounds]) => (globalThis as unknown as PageApi).measure(variant, rounds),
        [variant, rounds] as const,
      );
      if (variant !== "relaxed-only") strictMeanMs = result.strictMeanMs;
    }
    const windowEnd = Date.now();
    await sleep(afterMs);
    await context.close();
    context = undefined;
    const text = readFileSync(trace, "utf8");
    if (options.traces !== undefined && run === 1) {
      mkdirSync(options.traces, { recursive: true });
      copyFileSync(trace, path.join(options.traces, `${name}-${variant}.strace`));
    }
    return {
      browser: name,
      browserVersion,
      variant,
      run,
      rounds: variant === "baseline" ? 0 : rounds,
      windowMs: windowEnd - windowStart,
      strictMeanMs,
      syncs: {
        beforeWindow: countCalls(text, launched, windowStart),
        window: countCalls(text, windowStart, windowEnd),
        afterWindow: countCalls(text, windowEnd, Infinity),
      },
    };
  } finally {
    await context?.close();
    rmSync(profile, { recursive: true, force: true });
    rmSync(trace, { force: true });
  }
};

const require = createRequire(import.meta.url);
const strace = process.env.IDB_SYNC_STRACE ?? "strace";
const conditions = {
  date: new Date().toISOString(),
  node: process.version,
  playwright: (require("playwright/package.json") as { version: string }).version,
  strace: execFileSync(strace, ["-V"], { encoding: "utf8" }).split("\n")[0],
  kernel: release(),
  profileFileSystem: execFileSync("stat", ["-f", "-c", "%T", profileRoot], { encoding: "utf8" }).trim(),
  chromiumSandbox: process.env.IBUS_WEB_CHROMIUM_SANDBOX === "1",
  settleMs,
  baselineWindowMs,
  afterMs,
};

const results: Run[] = [];
try {
  for (const name of Object.keys(browsers) as BrowserName[]) {
    for (const variant of variants) {
      for (let run = 1; run <= runs; run++) {
        const result = await measure(name, variant, run);
        results.push(result);
        const format = (counts: Counts) =>
          Object.entries(counts)
            .map(([call, count]) => `${count} ${call}`)
            .join(", ") || "none";
        console.log(
          `${name} ${result.browserVersion} ${variant} #${run}: window ${result.windowMs} ms: ` +
            `${format(result.syncs.window)} (before ${format(result.syncs.beforeWindow)}; ` +
            `after ${format(result.syncs.afterWindow)})`,
        );
      }
    }
  }
} finally {
  server.close();
}
if (options.out !== undefined)
  writeFileSync(options.out, `${JSON.stringify({ conditions, runs: results }, null, 2)}\n`);
