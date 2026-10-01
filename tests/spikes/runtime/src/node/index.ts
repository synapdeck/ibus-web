// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import process from "node:process";
import type { Browser } from "playwright";
import { spike } from "../shared/spike.ts";

export const describe = (browser: Browser): string =>
  `${spike} in Node ${process.version}, driving ${browser.browserType().name()}`;
