// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The commands browser test files call, which run in Node beside the
// browser: what the page's Workers print to their consoles, the host's and
// its pthreads' alike.

import { consoleCommands } from "@ibus-web/test-programs/console";

export const commands = { ...consoleCommands({ from: "workers", format: "raw" }) };
