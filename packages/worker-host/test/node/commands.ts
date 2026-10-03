// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The commands browser test files call, which run in Node beside the
// browser: what the page's Workers print to their consoles, the host's and
// its pthreads' alike.

import type { ConsoleMessage, Page } from "playwright";
import type { BrowserCommand } from "vitest/node";

// Firefox warns that the runtime's legacy exception-handling instructions
// are deprecated, once for every Worker that instantiates it; every build
// with them would carry the warning until they are replaced.
const DEPRECATED_TRY = "WebAssembly exception handling 'try' instruction is deprecated";

const kept = new WeakMap<Page, string[]>();

const keptOf = (page: Page): string[] => {
  let lines = kept.get(page);
  if (lines === undefined) {
    const created: string[] = [];
    page.on("console", (message: ConsoleMessage) => {
      const text = message.text();
      // The test page's own console is Vitest's, which reports it itself.
      if (message.worker() === null || text.includes(DEPRECATED_TRY)) return;
      created.push(...text.split("\n").filter((line) => line !== ""));
    });
    kept.set(page, created);
    lines = created;
  }
  return lines;
};

// Starts keeping the console of the page's Workers, if it hasn't yet.
const consoleBegin: BrowserCommand<[]> = ({ page }) => {
  keptOf(page);
};

// The lines kept since the last call.
const consoleTake: BrowserCommand<[]> = ({ page }) => keptOf(page).splice(0);

export const commands = { consoleBegin, consoleTake };
