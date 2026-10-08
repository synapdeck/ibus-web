// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The commands Vitest's configuration gives browser test files, which run
// in Node beside the browser.

declare module "vitest/browser" {
  interface BrowserCommands {
    // Forgets the lines kept so far and keeps what the page's Workers print
    // to their consoles, the host's and its pthreads' alike, from now on.
    consoleBegin(): Promise<void>;
    // The lines kept since consoleBegin() or the last consoleTake().
    consoleTake(): Promise<string[]>;
  }
}

export {};
