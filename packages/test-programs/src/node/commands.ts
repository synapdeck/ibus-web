// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The commands browser test files call, which run in Node beside the browser.

import type { BrowserCommand } from "vitest/node";
import { consoleCommands } from "./console.ts";
import { parseTap } from "./tap.ts";

export const commands = {
  parseTap: ((_context, text: string) => parseTap(text)) satisfies BrowserCommand<[string]>,
  ...consoleCommands({ from: "page", format: "tagged" }),
};
