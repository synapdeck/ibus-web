// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The browsers the harnesses drive, headless, and the page they load.

import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, firefox, type Browser, type BrowserContext, type BrowserType } from "playwright";
import { serve, type Server } from "./server.ts";

const browserTypes: Readonly<Record<string, BrowserType>> = {
  chromium,
  firefox,
};

// The named browsers, or all of them; throws on a name it doesn't know.
export const browsersNamed = (names: readonly string[] | undefined): string[] => {
  const all = names ?? Object.keys(browserTypes);
  for (const name of all) if (!(name in browserTypes)) throw new Error(`no browser ${name}`);
  return [...all];
};

// Playwright turns Chromium's own sandbox off unless asked; runs keep it on,
// as a browser would, unless IBUS_WEB_CHROMIUM_SANDBOX=0.
const chromiumSandbox = process.env.IBUS_WEB_CHROMIUM_SANDBOX !== "0";

const options = (name: string) => (name === "chromium" ? { headless: true, chromiumSandbox } : { headless: true });

export const launch = (name: string): Promise<Browser> => browserTypes[name]!.launch(options(name));

// A browser whose one context keeps its storage on disk, in dir. A context
// of launch()'s browser is off the record, and Chromium keeps such a
// context's IndexedDB in memory.
export const launchPersistent = (name: string, dir: string): Promise<BrowserContext> =>
  browserTypes[name]!.launchPersistentContext(dir, options(name));

// Its first line: Playwright's launch errors go on to list the browser's
// whole output.
export const launchError = (error: unknown): string =>
  `launch failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;

// Serves the page at / and the TypeScript build under /dist/, with dirs
// besides, by URL prefix.
export const servePage = (dirs: Readonly<Record<string, string>> = {}): Promise<Server> =>
  serve(fileURLToPath(new URL("../../src/page/index.html", import.meta.url)), {
    "/dist/": fileURLToPath(new URL("../", import.meta.url)),
    ...dirs,
  });
