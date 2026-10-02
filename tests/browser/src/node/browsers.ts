// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The browsers runs drive, headless.

import process from "node:process";
import { chromium, firefox, type Browser, type BrowserType } from "playwright";

export const browserTypes: Readonly<Record<string, BrowserType>> = {
  chromium,
  firefox,
};

// The named browsers, or all of them; throws on a name it doesn't know.
export const browsersNamed = (
  names: readonly string[] | undefined,
): string[] => {
  const all = names ?? Object.keys(browserTypes);
  for (const name of all)
    if (!(name in browserTypes)) throw new Error(`no browser ${name}`);
  return [...all];
};

// Playwright turns Chromium's own sandbox off unless asked; runs keep it on,
// as a browser would, unless IBUS_WEB_CHROMIUM_SANDBOX=0.
const chromiumSandbox = process.env.IBUS_WEB_CHROMIUM_SANDBOX !== "0";

export const launch = (name: string): Promise<Browser> =>
  browserTypes[name]!.launch(
    name === "chromium"
      ? { headless: true, chromiumSandbox }
      : { headless: true },
  );

// Its first line: Playwright's launch errors go on to list the browser's
// whole output.
export const launchError = (error: unknown): string =>
  `launch failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
