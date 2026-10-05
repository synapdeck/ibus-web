// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import process from "node:process";
import { defineConfig } from "vitest/config";

const cacheDir = process.env["IBUS_WEB_TEST_CACHE_DIR"];
export default defineConfig({
  ...(cacheDir === undefined ? {} : { cacheDir }),
  test: {
    include: ["test/node/**/*.test.ts"],
    exclude: [
      "test/node/engine.test.ts",
      "test/node/protocol.test.ts",
      "test/node/ring.test.ts",
      "test/node/scenarios.test.ts",
    ],
  },
});
