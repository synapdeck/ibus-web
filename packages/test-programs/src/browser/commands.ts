// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The commands Vitest's configuration gives browser test files, which run
// in Node beside the browser.

import type { OutputLine, ParsedReport } from "../shared/protocol.ts";

declare module "vitest/browser" {
  interface BrowserCommands {
    // Reads a TAP program's stdout.
    parseTap(text: string): Promise<ParsedReport>;
    // Forgets the console messages kept so far and keeps the page's, its
    // Workers' included, from now on.
    consoleBegin(): Promise<void>;
    // The messages kept since consoleBegin() or the last consoleTake().
    consoleTake(): Promise<OutputLine[]>;
  }
}
