// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { defineConfig } from "vitest/config";
import { browserMode, crossOriginIsolation } from "@ibus-web/test-programs/vitest";
export default defineConfig({
  ...(process.env["IBUS_WEB_TEST_CACHE_DIR"] ? { cacheDir: process.env["IBUS_WEB_TEST_CACHE_DIR"] } : {}),
  server: { headers: crossOriginIsolation },
  test: {
    include: ["test/browser/**/*.test.ts"],
    fileParallelism: false,
    browser: browserMode(["chromium", "firefox"], {}),
  },
});
