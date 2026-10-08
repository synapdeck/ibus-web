// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Browser commands that keep what a test page's consoles print, for a suite
// to take once the code under test has printed it. They run in Node beside
// the browser.

import type { ConsoleMessage, Page } from "playwright";
import type { BrowserCommand } from "vitest/node";
import type { OutputLine } from "../shared/protocol.ts";

// Firefox warns that a module's legacy exception-handling instructions are
// deprecated, once for every Worker that instantiates it; every build with
// them would carry the warning until they are replaced.
const DEPRECATED_TRY = "WebAssembly exception handling 'try' instruction is deprecated";

export interface ConsoleOptions {
  // "page" keeps the page's console, its Workers' and the page's uncaught
  // errors. "workers" keeps its Workers' alone, for a suite whose page is
  // Vitest's own test page, whose console Vitest already reports.
  readonly from: "page" | "workers";
  // "tagged" keeps each message as one OutputLine saying where it came from;
  // "raw" keeps each non-empty line of its text.
  readonly format: "tagged" | "raw";
}

export interface ConsoleCommands {
  // Forgets whatever was kept and keeps from now on.
  readonly consoleBegin: BrowserCommand<[]>;
  // What was kept since consoleBegin or the last consoleTake.
  readonly consoleTake: BrowserCommand<[]>;
}

type Kept = (OutputLine | string)[];

export const consoleCommands = (options: ConsoleOptions): ConsoleCommands => {
  const kept = new WeakMap<Page, Kept>();

  const keep = (lines: Kept, source: string, text: string): void => {
    if (options.format === "tagged") {
      lines.push({ stream: "console", text: `[${source}] ${text}` });
    } else {
      lines.push(...text.split("\n").filter((line) => line !== ""));
    }
  };

  const keptOf = (page: Page): Kept => {
    let lines = kept.get(page);

    if (lines === undefined) {
      const created: Kept = [];

      page.on("console", (message: ConsoleMessage) => {
        const text = message.text();

        if ((options.from === "workers" && message.worker() === null) || text.includes(DEPRECATED_TRY)) return;

        keep(created, `console.${message.type()}`, text);
      });

      if (options.from === "page") {
        page.on("pageerror", (error) => keep(created, "pageerror", error.message));
      }

      kept.set(page, created);
      lines = created;
    }

    return lines;
  };

  return {
    consoleBegin: ({ page }) => {
      keptOf(page).length = 0;
    },
    consoleTake: ({ page }) => keptOf(page).splice(0),
  };
};
