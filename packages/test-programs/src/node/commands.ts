// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The commands browser test files call, which run in Node beside the browser.

import type { ConsoleMessage, Page } from "playwright";
import type { BrowserCommand } from "vitest/node";
import type { OutputLine } from "../shared/protocol.ts";
import { parseTap } from "./tap.ts";

// Firefox warns that a module's legacy exception-handling instructions are
// deprecated, once for every Worker that instantiates it; every program
// built with them would carry the warning until they are replaced.
const DEPRECATED_TRY = "WebAssembly exception handling 'try' instruction is deprecated";

interface Capture {
  lines: OutputLine[] | undefined;
}

const captures = new WeakMap<Page, Capture>();

const captureOf = (page: Page): Capture => {
  let capture = captures.get(page);
  if (capture === undefined) {
    const created: Capture = { lines: undefined };
    page.on("console", (message: ConsoleMessage) => {
      const text = message.text();
      if (created.lines === undefined || text.includes(DEPRECATED_TRY)) return;
      created.lines.push({ stream: "console", text: `[console.${message.type()}] ${text}` });
    });
    page.on("pageerror", (error) => created.lines?.push({ stream: "console", text: `[pageerror] ${error.message}` }));
    captures.set(page, created);
    capture = created;
  }
  return capture;
};

const consoleBegin: BrowserCommand<[]> = ({ page }) => {
  captureOf(page).lines = [];
};

const consoleTake: BrowserCommand<[]> = ({ page }) => {
  const capture = captureOf(page);
  const lines = capture.lines ?? [];
  capture.lines = undefined;
  return lines;
};

export const commands = {
  parseTap: ((_context, text: string) => parseTap(text)) satisfies BrowserCommand<[string]>,
  consoleBegin,
  consoleTake,
};
