// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node experiments.js [--browser chromium|firefox]...
//
// Browser behaviour the runtime spike depends on, measured without the
// runtime, in headless browsers through Playwright, with tables printed as
// markdown:
//
//  - nested Workers: when a Worker created by a blocked Worker starts, and
//    which OPFS calls and Worker creations in a Worker wait for the page's
//    main thread, with it free and with it spinning;
//  - sync access handles: which can be open on one file at once, in one
//    Worker, two Workers or two pages, by the mode each asks for (an option
//    only Chromium knows), and whether reading the file as a Blob or
//    opening a writable stream works meanwhile.

import process from "node:process";
import { parseArgs } from "node:util";
import type { Browser, BrowserContext, Page } from "playwright";
import { nestedLabels, type ExperimentCommand } from "../shared/experiments.ts";
import { browsersNamed, launch, launchError, servePage } from "./browsers.ts";

const { values: args } = parseArgs({
  options: { browser: { type: "string", multiple: true } },
});
const browserNames = browsersNamed(args.browser);

// How long the nested experiment's Worker A blocks, and the page spins.
const BLOCK_MS = 3000;

const FILE = "lock.txt";
// undefined asks for no mode, which is what WasmFS does.
const MODES = [undefined, "readwrite", "read-only", "readwrite-unsafe"];
const modeName = (mode: string | undefined): string => mode ?? "(none)";

type Reply = { result?: unknown; error?: string };

const ready = async (
  context: BrowserContext,
  origin: string,
): Promise<Page> => {
  const page = await context.newPage();
  page.on("pageerror", (error) =>
    process.stderr.write(`[pageerror] ${error.message}\n`),
  );
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => "experiments" in globalThis);
  return page;
};

const startWorker = (page: Page, name: string): Promise<void> =>
  page.evaluate(
    (name) =>
      (
        globalThis as unknown as { experiments: { start(name: string): void } }
      ).experiments.start(name),
    name,
  );

const send = (
  page: Page,
  name: string,
  command: ExperimentCommand,
): Promise<Reply> =>
  page.evaluate(
    ([name, command]) =>
      (
        globalThis as unknown as {
          experiments: {
            send(name: string, command: ExperimentCommand): Promise<Reply>;
          };
        }
      ).experiments.send(name, command),
    [name, command] as const,
  );

const outcome = ({ error }: Reply): string => error ?? "ok";

// Opens a handle in worker on page, runs then, and closes it again.
const holding = async (
  page: Page,
  worker: string,
  mode: string | undefined,
  then: () => Promise<string>,
): Promise<string> => {
  const opened = await send(page, worker, {
    op: "open",
    file: FILE,
    ...(mode === undefined ? {} : { mode }),
  });
  if (opened.error !== undefined) return `first open: ${opened.error}`;
  try {
    return await then();
  } finally {
    await send(page, worker, { op: "close", handle: opened.result as number });
  }
};

const tryOpen = async (
  page: Page,
  worker: string,
  mode: string | undefined,
): Promise<string> => {
  const opened = await send(page, worker, {
    op: "open",
    file: FILE,
    ...(mode === undefined ? {} : { mode }),
  });
  if (opened.result !== undefined)
    await send(page, worker, { op: "close", handle: opened.result as number });
  return outcome(opened);
};

const nestedRows = async (browser: Browser, origin: string) => {
  const columns: Record<string, number | null>[] = [];
  for (const spin of [false, true]) {
    const context = await browser.newContext();
    try {
      const page = await ready(context, origin);
      columns.push(
        await page.evaluate(
          ([spin, blockMs]) =>
            (
              globalThis as unknown as {
                experiments: {
                  nested(
                    spin: boolean,
                    blockMs: number,
                  ): Promise<Record<string, number | null>>;
                };
              }
            ).experiments.nested(spin, blockMs),
          [spin, BLOCK_MS] as const,
        ),
      );
    } finally {
      await context.close();
    }
  }
  return columns;
};

const lockRows = async (browser: Browser, origin: string) => {
  const rows: [string, string][] = [];
  const context = await browser.newContext();
  try {
    const first = await ready(context, origin);
    const second = await ready(context, origin);
    await startWorker(first, "X");
    await startWorker(first, "Y");
    await startWorker(second, "Z");
    const created = await send(first, "X", { op: "create", file: FILE });
    if (created.error !== undefined)
      throw new Error(`create: ${created.error}`);

    for (const held of MODES)
      for (const asked of MODES)
        rows.push([
          `X holds ${modeName(held)}; Y opens ${modeName(asked)}`,
          await holding(first, "X", held, () => tryOpen(first, "Y", asked)),
        ]);
    for (const mode of [undefined, "read-only"])
      rows.push(
        [
          `X holds ${modeName(mode)}; X opens ${modeName(mode)} again`,
          await holding(first, "X", mode, () => tryOpen(first, "X", mode)),
        ],
        [
          `X holds ${modeName(mode)}; Z, in another page, opens ${modeName(mode)}`,
          await holding(first, "X", mode, () => tryOpen(second, "Z", mode)),
        ],
      );
    for (const mode of MODES)
      rows.push(
        [
          `X holds ${modeName(mode)}; Y reads it as a Blob`,
          await holding(first, "X", mode, async () =>
            outcome(await send(first, "Y", { op: "read-blob", file: FILE })),
          ),
        ],
        [
          `X holds ${modeName(mode)}; Y opens a writable stream`,
          await holding(first, "X", mode, async () =>
            outcome(
              await send(first, "Y", { op: "create-writable", file: FILE }),
            ),
          ),
        ],
      );
    const readOnly = await send(first, "X", {
      op: "open",
      file: FILE,
      mode: "read-only",
    });
    let write = `open: ${readOnly.error}`;
    if (readOnly.result !== undefined) {
      const handle = readOnly.result as number;
      const written = await send(first, "X", { op: "write", handle });
      write = written.error ?? `wrote ${String(written.result)} byte`;
      await send(first, "X", { op: "close", handle });
    }
    rows.push(["X writes through a handle it opened read-only", write]);
  } finally {
    await context.close();
  }
  return rows;
};

const server = await servePage();
const nested = new Map<string, Record<string, number | null>[]>();
const locks = new Map<string, [string, string][]>();
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
      nested.set(name, await nestedRows(browser, server.origin));
      locks.set(name, await lockRows(browser, server.origin));
    } catch (error) {
      failures.push(`${name}: ${String(error)}`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}

const cell = (ms: number | null | undefined): string =>
  ms === null || ms === undefined ? "never" : String(Math.round(ms));
const ran = [...nested.keys()];
const lines = (...text: string[]): void => console.log(text.join("\n"));
lines(
  `## Nested Workers: ms after go (A blocks ${BLOCK_MS} ms; the page's thread free, or spinning as long)`,
  "",
  `| Step | ${ran.flatMap((name) => [`${name}, page free`, `${name}, page spins`]).join(" | ")} |`,
  `| --- |${" --- |".repeat(ran.length * 2)}`,
);
for (const [step, label] of Object.entries(nestedLabels))
  console.log(
    `| ${label} | ${ran
      .flatMap((name) => nested.get(name)!.map((column) => cell(column[step])))
      .join(" | ")} |`,
  );
const lockRan = [...locks.keys()];
lines(
  "",
  "## Sync access handles on one file",
  "",
  `| Case | ${lockRan.join(" | ")} |`,
  `| --- |${" --- |".repeat(lockRan.length)}`,
);
const first = locks.get(lockRan[0]!) ?? [];
first.forEach(([label], i) =>
  console.log(
    `| ${label} | ${lockRan.map((name) => locks.get(name)![i]![1]).join(" | ")} |`,
  ),
);
for (const failure of failures) console.log(`FAIL ${failure}`);
process.exit(failures.length > 0 ? 1 : 0);
