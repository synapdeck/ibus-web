// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The commands Vitest's configuration gives browser test files, which run
// in Node beside the browser.

declare module "vitest/browser" {
  interface BrowserCommands {
    // Starts keeping what the page's Workers print to their consoles, the
    // host's and its pthreads' alike, if it hasn't yet.
    consoleBegin(): Promise<void>;
    // The lines kept since the last call.
    consoleTake(): Promise<string[]>;
  }
}

export {};
