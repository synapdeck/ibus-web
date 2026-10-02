// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node storage.js [--browser chromium|firefox]... [--repeat N]
//
// Where an engine's data could live, measured without the runtime in
// headless browsers through Playwright, with tables printed as markdown:
//
//  - under a spin: a Worker reads (or writes) 4 MiB from IndexedDB with
//    ArrayBuffer or Blob values, Cache Storage, and the origin's private
//    file system by Blob and by sync access handle, while the page's main
//    thread is free and while it spins as the keystroke path does; each step
//    is timed from when the page sent the command;
//  - concurrency: what two Workers, or Workers of two pages, can do to the
//    same data at once;
//  - latency: random reads of 4 KiB and 64 KiB, page free.
//
// Every run gets a browser context of its own, so storage starts empty.

import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { Browser, BrowserContext, Page } from "playwright";
import type {
  LatencySource,
  StorageCommand,
  StoreLayout,
  TimedCommand,
  Timing,
  UpgradeOutcome,
} from "../shared/storage.ts";
import { browsersNamed, launch, launchError, servePage } from "./browsers.ts";

const { values: args } = parseArgs({
  options: {
    browser: { type: "string", multiple: true },
    repeat: { type: "string", default: "3" },
  },
});
const browserNames = browsersNamed(args.browser);
const REPEAT = Number(args.repeat);

// Five times D6's 40 ms: long enough that a step that waits for the page
// can't be mistaken for a slow one.
const SPIN_MS = 200;
const KiB = 1024;
const MiB = 1024 * KiB;
const DB = "engine";
const CACHE = "engine";
const FILE = "engine.dat";

const layouts = {
  ab64k: { name: "ab64k", chunks: 64, size: 64 * KiB, blob: false },
  blob64k: { name: "blob64k", chunks: 64, size: 64 * KiB, blob: true },
  ab4k: { name: "ab4k", chunks: 1024, size: 4 * KiB, blob: false },
  big: { name: "big", chunks: 1, size: 4 * MiB, blob: false },
} satisfies Record<string, StoreLayout>;

type Reply = { result?: unknown; error?: string };
type Spun = { spinEnd: number | null; replies: Reply[] };

const ready = async (context: BrowserContext, origin: string): Promise<Page> => {
  const page = await context.newPage();
  page.on("pageerror", (error) => process.stderr.write(`[pageerror] ${error.message}\n`));
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => "experiments" in globalThis);
  return page;
};

type PageExperiments = {
  experiments: {
    start(name: string): void;
    send(name: string, command: StorageCommand): Promise<Reply>;
    timed(sends: [string, TimedCommand][], spinMs: number): Promise<Spun>;
  };
};

const startWorker = (page: Page, name: string): Promise<void> =>
  page.evaluate((name) => (globalThis as unknown as PageExperiments).experiments.start(name), name);

const send = async (page: Page, name: string, command: StorageCommand): Promise<unknown> => {
  const reply = await page.evaluate(
    ([name, command]) => (globalThis as unknown as PageExperiments).experiments.send(name, command),
    [name, command] as const,
  );
  if (reply.error !== undefined) throw new Error(`${command.op}: ${reply.error}`);
  return reply.result;
};

const timed = (page: Page, sends: [string, TimedCommand][], spinMs: number): Promise<Spun> =>
  page.evaluate(([sends, spinMs]) => (globalThis as unknown as PageExperiments).experiments.timed(sends, spinMs), [
    sends,
    spinMs,
  ] as const);

// Each run's data, written from its Worker X with the page free.
type Setup = { stores?: StoreLayout[]; cache?: boolean; file?: boolean };

const setUp = async (page: Page, setup: Setup): Promise<void> => {
  if (setup.stores !== undefined) await send(page, "X", { op: "idb-fill", db: DB, stores: setup.stores });
  if (setup.cache === true)
    await send(page, "X", {
      op: "cache-fill",
      cache: CACHE,
      chunks: 64,
      size: 64 * KiB,
    });
  if (setup.file === true) await send(page, "X", { op: "opfs-fill", file: FILE, size: 4 * MiB });
};

// A fresh context with a page, its Workers and the data.
const withPage = async <T>(
  browser: Browser,
  origin: string,
  workers: string[],
  setup: Setup,
  body: (page: Page, context: BrowserContext) => Promise<T>,
): Promise<T> => {
  const context = await browser.newContext();
  try {
    const page = await ready(context, origin);
    for (const name of workers) await startWorker(page, name);
    await setUp(page, setup);
    // Lets the writes' background work settle before anything is timed.
    await sleep(100);
    return await body(page, context);
  } finally {
    await context.close();
  }
};

type SpinCase = {
  label: string;
  setup: Setup;
  // Opens the database in X before the command, as an engine would at start.
  warm?: boolean;
  command: TimedCommand;
};

const read64k = { chunks: 64, size: 64 * KiB };
const spinCases: SpinCase[] = [
  {
    label: "IndexedDB, ArrayBuffer values: open, then read 64 × 64 KiB in one readonly transaction",
    setup: { stores: [layouts.ab64k] },
    command: { op: "idb-read", epoch: 0, db: DB, store: "ab64k", chunks: 64 },
  },
  {
    label: "IndexedDB, ArrayBuffer values, already open: read 64 × 64 KiB in one readonly transaction",
    setup: { stores: [layouts.ab64k] },
    warm: true,
    command: { op: "idb-read", epoch: 0, db: DB, store: "ab64k", chunks: 64 },
  },
  {
    label: "IndexedDB, already open: read one 4 MiB ArrayBuffer value",
    setup: { stores: [layouts.big] },
    warm: true,
    command: { op: "idb-read", epoch: 0, db: DB, store: "big", chunks: 1 },
  },
  {
    label: "IndexedDB, already open: write 64 × 64 KiB ArrayBuffers in one readwrite transaction",
    setup: { stores: [layouts.ab64k] },
    warm: true,
    command: {
      op: "idb-write",
      epoch: 0,
      db: DB,
      store: "ab64k",
      ...read64k,
    },
  },
  {
    label: "IndexedDB, Blob values, already open: get 64 × 64 KiB in one readonly transaction, then read each Blob",
    setup: { stores: [layouts.blob64k] },
    warm: true,
    command: {
      op: "idb-read",
      epoch: 0,
      db: DB,
      store: "blob64k",
      chunks: 64,
    },
  },
  {
    label: "Cache Storage: open, then match and read 64 × 64 KiB responses",
    setup: { cache: true },
    command: { op: "cache-read", epoch: 0, cache: CACHE, chunks: 64 },
  },
  {
    label: "OPFS, Blob: getFile(), then read 64 × 64 KiB slices",
    setup: { file: true },
    command: { op: "opfs-blob-read", epoch: 0, file: FILE, ...read64k },
  },
  {
    label: "OPFS, sync access handle: open, read 64 × 64 KiB, close",
    setup: { file: true },
    command: { op: "opfs-sync-read", epoch: 0, file: FILE, ...read64k },
  },
];

// Per case, per step: ms after go in each run, page free and page spinning,
// and how many spinning runs ended the step before the spin did.
type StepResult = {
  free: number[];
  spun: number[];
  duringSpin: number;
};
type CaseResult = { steps: Map<string, StepResult>; errors: string[] };

const spinRows = async (browser: Browser, origin: string): Promise<CaseResult[]> => {
  const results: CaseResult[] = [];
  for (const spinCase of spinCases) {
    const steps = new Map<string, StepResult>();
    const errors: string[] = [];
    for (let run = 0; run < REPEAT; run++)
      for (const spinMs of [0, SPIN_MS]) {
        const { spinEnd, replies } = await withPage(browser, origin, ["X"], spinCase.setup, async (page) => {
          if (spinCase.warm === true) await send(page, "X", { op: "idb-open", db: DB });
          return timed(page, [["X", spinCase.command]], spinMs);
        });
        const [reply] = replies;
        if (reply!.error !== undefined) {
          errors.push(`${spinMs > 0 ? "spin" : "free"}: ${reply!.error}`);
          continue;
        }
        for (const [step, ms] of (reply!.result as Timing).marks) {
          const result = steps.get(step) ?? {
            free: [],
            spun: [],
            duringSpin: 0,
          };
          steps.set(step, result);
          if (spinEnd === null) result.free.push(ms);
          else {
            result.spun.push(ms);
            if (ms < spinEnd) result.duringSpin++;
          }
        }
      }
    results.push({ steps, errors });
  }
  return results;
};

const describe = (spun: Spun): string =>
  spun.replies
    .map(({ result, error }) => {
      if (error !== undefined) return error;
      const { marks } = result as Timing;
      return `ok, ${marks.at(-1)![1].toFixed(1)} ms`;
    })
    .join("; ");

const readAll: TimedCommand = {
  op: "idb-read",
  epoch: 0,
  db: DB,
  store: "ab64k",
  chunks: 64,
};

const concurrencyRows = async (browser: Browser, origin: string): Promise<[string, string][]> => {
  const rows: [string, string][] = [];
  const both = (spinMs: number) =>
    withPage(browser, origin, ["X", "Y"], { stores: [layouts.ab64k] }, async (page) =>
      describe(
        await timed(
          page,
          [
            ["X", readAll],
            ["Y", readAll],
          ],
          spinMs,
        ),
      ),
    );
  rows.push(
    ["X and Y, Workers of one page, each read the 64 chunks at once (X; Y)", await both(0)],
    [`The same, the page spinning ${SPIN_MS} ms`, await both(SPIN_MS)],
  );
  rows.push([
    "X (page 1) and Z (page 2) read the 64 chunks at once, each holding a connection open since before (X; Z)",
    await withPage(browser, origin, ["X"], { stores: [layouts.ab64k] }, async (first, context) => {
      const second = await ready(context, origin);
      await startWorker(second, "Z");
      await send(first, "X", { op: "idb-open", db: DB });
      await send(second, "Z", { op: "idb-open", db: DB });
      const [x, z] = await Promise.all([timed(first, [["X", readAll]], 0), timed(second, [["Z", readAll]], 0)]);
      return `${describe(x)}; ${describe(z)}`;
    }),
  ]);
  rows.push([
    "Y reads the 64 chunks while X writes them in one readwrite transaction (X; Y)",
    await withPage(browser, origin, ["X", "Y"], { stores: [layouts.ab64k] }, async (page) => {
      await send(page, "X", { op: "idb-open", db: DB });
      return describe(
        await timed(
          page,
          [
            [
              "X",
              {
                op: "idb-write",
                epoch: 0,
                db: DB,
                store: "ab64k",
                ...read64k,
              },
            ],
            ["Y", readAll],
          ],
          0,
        ),
      );
    }),
  ]);
  rows.push([
    "Z (page 2) opens the database at version 2 while X (page 1) holds a connection, which X closes 300 ms later",
    await withPage(browser, origin, ["X"], { stores: [layouts.ab64k] }, async (first, context) => {
      const second = await ready(context, origin);
      await startWorker(second, "Z");
      await send(first, "X", { op: "idb-open", db: DB });
      const upgrade = send(second, "Z", {
        op: "idb-upgrade",
        db: DB,
        version: 2,
        waitMs: 5000,
      }) as Promise<UpgradeOutcome>;
      await sleep(300);
      const events = (await send(first, "X", {
        op: "idb-close",
        db: DB,
      })) as string[];
      const { blocked, opened, ms } = await upgrade;
      return `X sees ${events.join(", ") || "no event"}; Z ${blocked ? "blocked, then " : ""}${opened ? `opened after ${Math.round(ms)} ms` : "not opened"}`;
    }),
  ]);
  rows.push([
    "Cache Storage: X and Y read the 64 responses at once (X; Y)",
    await withPage(browser, origin, ["X", "Y"], { cache: true }, async (page) => {
      const read: TimedCommand = {
        op: "cache-read",
        epoch: 0,
        cache: CACHE,
        chunks: 64,
      };
      return describe(
        await timed(
          page,
          [
            ["X", read],
            ["Y", read],
          ],
          0,
        ),
      );
    }),
  ]);
  const syncRead: TimedCommand = {
    op: "opfs-sync-read",
    epoch: 0,
    file: FILE,
    ...read64k,
  };
  rows.push([
    "OPFS: Y reads through a sync access handle while X holds one",
    await withPage(browser, origin, ["X", "Y"], { file: true }, async (page) => {
      await send(page, "X", { op: "opfs-hold", file: FILE });
      return describe(await timed(page, [["Y", syncRead]], 0));
    }),
  ]);
  return rows;
};

const READS = 256;
type LatencyCase = {
  label: string;
  source: LatencySource;
  store: string;
  count: number;
  size: number;
};
const latencyCases: LatencyCase[] = [];
for (const [size, store, count] of [
  [4 * KiB, "ab4k", 1024],
  [64 * KiB, "ab64k", 64],
] as const) {
  const kib = `${size / KiB} KiB`;
  latencyCases.push(
    {
      label: `IndexedDB, ${kib}, a readonly transaction per read`,
      source: "idb-tx-per-read",
      store,
      count,
      size,
    },
    {
      label: `IndexedDB, ${kib}, ${READS} reads in one readonly transaction`,
      source: "idb-one-tx",
      store,
      count,
      size,
    },
    {
      label: `OPFS, ${kib}, sync access handle read()`,
      source: "opfs-sync",
      store,
      count,
      size,
    },
    {
      label: `OPFS, ${kib}, Blob slice arrayBuffer()`,
      source: "opfs-blob",
      store,
      count,
      size,
    },
  );
}

// Median, 95th percentile and mean, in µs.
const summary = (ms: number[]): string => {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const mean = ms.reduce((sum, x) => sum + x, 0) / ms.length;
  const us = (x: number): string => String(Math.round(x * 1000));
  return `${us(at(0.5))} / ${us(at(0.95))} / ${us(mean)}`;
};

const latencyRows = (browser: Browser, origin: string): Promise<string[]> =>
  withPage(browser, origin, ["X"], { stores: [layouts.ab4k, layouts.ab64k], file: true }, async (page) => {
    const cells: string[] = [];
    for (const { source, store, count, size } of latencyCases)
      cells.push(
        summary(
          (await send(page, "X", {
            op: "latency",
            source,
            db: DB,
            store,
            file: FILE,
            count,
            size,
            reads: READS,
          })) as number[],
        ),
      );
    return cells;
  });

const server = await servePage();
const spins = new Map<string, CaseResult[]>();
const concurrency = new Map<string, [string, string][]>();
const latency = new Map<string, string[]>();
const failures: string[] = [];
try {
  for (const name of browserNames) {
    let browser: Browser;
    try {
      browser = await launch(name);
    } catch (error) {
      failures.push(`${name}: ${launchError(error)}`);
      continue;
    }
    try {
      process.stderr.write(`# ${name}\n`);
      spins.set(name, await spinRows(browser, server.origin));
      concurrency.set(name, await concurrencyRows(browser, server.origin));
      latency.set(name, await latencyRows(browser, server.origin));
    } catch (error) {
      failures.push(`${name}: ${String(error)}`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}

const range = (ms: number[]): string => {
  if (ms.length === 0) return "—";
  const low = Math.min(...ms).toFixed(1);
  const high = Math.max(...ms).toFixed(1);
  return low === high ? low : `${low}–${high}`;
};
const lines = (...text: string[]): void => console.log(text.join("\n"));
for (const [name, results] of spins) {
  lines(
    `## ${name}: ms after the command was sent, ${REPEAT} runs (min–max), page free or spinning ${SPIN_MS} ms`,
    "",
    `| Operation | Step | Page free | Page spins | Ends during the spin |`,
    "| --- | --- | --- | --- | --- |",
  );
  results.forEach(({ steps, errors }, i) => {
    let label = spinCases[i]!.label;
    for (const [step, { free, spun, duringSpin }] of steps) {
      console.log(`| ${label} | ${step} | ${range(free)} | ${range(spun)} | ${duringSpin}/${spun.length} |`);
      label = "";
    }
    for (const error of errors) console.log(`| ${label} | error | ${error} | | |`);
  });
  console.log("");
}
const ran = [...concurrency.keys()];
lines("## Concurrency", "", `| Case | ${ran.join(" | ")} |`, `| --- |${" --- |".repeat(ran.length)}`);
concurrency
  .get(ran[0]!)
  ?.forEach(([label], i) =>
    console.log(`| ${label} | ${ran.map((name) => concurrency.get(name)![i]![1]).join(" | ")} |`),
  );
const latencyRan = [...latency.keys()];
lines(
  "",
  `## Random reads, page free: µs per read, median / 95th percentile / mean of ${READS}`,
  "",
  `| Read | ${latencyRan.join(" | ")} |`,
  `| --- |${" --- |".repeat(latencyRan.length)}`,
);
latencyCases.forEach(({ label }, i) =>
  console.log(`| ${label} | ${latencyRan.map((name) => latency.get(name)![i]).join(" | ")} |`),
);
for (const failure of failures) console.log(`FAIL ${failure}`);
process.exit(failures.length > 0 ? 1 : 0);
