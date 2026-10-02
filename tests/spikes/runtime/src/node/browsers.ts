// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The browsers the harnesses drive, headless, and the page they load.

import { fileURLToPath } from "node:url";
import { serve, type Server } from "@ibus-web/test-browser/server";

export {
  browsersNamed,
  launch,
  launchError,
} from "@ibus-web/test-browser/browsers";

// Serves the page at / and the TypeScript build under /dist/, with dirs
// besides, by URL prefix.
export const servePage = (
  dirs: Readonly<Record<string, string>> = {},
): Promise<Server> =>
  serve(fileURLToPath(new URL("../../src/page/index.html", import.meta.url)), {
    "/dist/": fileURLToPath(new URL("../", import.meta.url)),
    ...dirs,
  });
