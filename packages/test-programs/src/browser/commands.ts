// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The commands Vitest's configuration gives browser test files, which run
// in Node beside the browser.

import type { OutputLine, ParsedReport } from "../shared/protocol.ts";

declare module "vitest/browser" {
  interface BrowserCommands {
    // Reads a TAP program's stdout.
    parseTap(text: string): Promise<ParsedReport>;
    // Starts keeping the page's console messages, its Workers' included,
    // and forgets any kept before.
    consoleBegin(): Promise<void>;
    // The messages kept since consoleBegin(); stops keeping them.
    consoleTake(): Promise<OutputLine[]>;
  }
}
