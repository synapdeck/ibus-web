// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node growrace.js --dir DIR [--browser chromium|firefox]...
//                         [--runs N] [--readers N] [--pages N]
//
// The memory spike's growrace.html (in DIR) in headless browsers: a page
// grows a shared memory while module Workers increment the words it
// publishes, in each of growrace.mjs's ways, and then atomically on a memory
// that never grows; each race in a browser context of its own. Prints a
// line per race and per configuration, then a RESULTS line of JSON. Exits 1
// if any reader trapped.

import process from "node:process";
import { parseArgs } from "node:util";
import { browsersNamed, launch, launchError, servePage } from "./browsers.ts";

const { values: args } = parseArgs({
  options: {
    dir: { type: "string" },
    browser: { type: "string", multiple: true },
    runs: { type: "string", default: "5" },
    readers: { type: "string", default: "16" },
    pages: { type: "string", default: "8192" },
  },
});
if (args.dir === undefined) throw new Error("--dir is required");
const runs = Number(args.runs);
const readers = Number(args.readers);
const pages = Number(args.pages);

interface RaceResult {
  published: number;
  traps: string[];
  increments: number;
}

const configurations = [
  ...["plain", "atomic", "atomic-callee", "atomic-after-js"].map((access) => ({
    access,
    grow: true,
  })),
  { access: "atomic", grow: false },
];

interface Tally {
  browser: string;
  access: string;
  grow: boolean;
  runs: number;
  runsTrapped: number;
  readersTrapped: number;
  traps: string[];
  errors: string[];
}

const server = await servePage({ "/memory/": args.dir });
const tallies: Tally[] = [];
try {
  for (const name of browsersNamed(args.browser)) {
    let browser;
    try {
      browser = await launch(name);
    } catch (error) {
      console.log(`${name}: ${launchError(error)}`);
      continue;
    }
    try {
      for (const { access, grow } of configurations) {
        const label = `${name} ${access}${grow ? "" : ", never grown"}`;
        const tally: Tally = {
          browser: name,
          access,
          grow,
          runs: 0,
          runsTrapped: 0,
          readersTrapped: 0,
          traps: [],
          errors: [],
        };
        tallies.push(tally);
        for (let run = 1; run <= runs; run++) {
          const context = await browser.newContext();
          try {
            const page = await context.newPage();
            await page.goto(`${server.origin}/memory/growrace.html`);
            await page.waitForFunction(() => "race" in globalThis);
            const result = await page.evaluate(
              (options) =>
                (
                  globalThis as unknown as {
                    race(options: object): Promise<RaceResult>;
                  }
                ).race(options),
              { readers, pages, access, grow },
            );
            tally.runs++;
            if (result.traps.length > 0) tally.runsTrapped++;
            tally.readersTrapped += result.traps.length;
            tally.traps.push(...new Set(result.traps));
            console.log(
              `${label} race ${run}: ${result.increments} increments, ` +
                `${result.traps.length} of ${readers} readers trapped` +
                (result.traps.length > 0 ? ` (${result.traps[0]})` : ""),
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            tally.errors.push(message);
            console.log(`${label} race ${run}: FAIL ${message}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
for (const tally of tallies) {
  tally.traps = [...new Set(tally.traps)];
  console.log(
    `${tally.browser}: ${tally.access}${tally.grow ? "" : ", never grown"}: ` +
      `${tally.runsTrapped} of ${tally.runs} races trapped (${tally.readersTrapped} readers)` +
      (tally.traps.length > 0 ? `: ${tally.traps[0]}` : "") +
      (tally.errors.length > 0
        ? `; ${tally.errors.length} failed: ${tally.errors[0]}`
        : ""),
  );
}
console.log(`RESULTS ${JSON.stringify({ readers, pages, tallies })}`);
process.exit(
  tallies.some(
    ({ runsTrapped, errors }) => runsTrapped > 0 || errors.length > 0,
  )
    ? 1
    : 0,
);
