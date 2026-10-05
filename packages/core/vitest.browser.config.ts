// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { defineConfig } from "vitest/config";
import { browserMode, crossOriginIsolation } from "@ibus-web/test-programs/vitest";
export default defineConfig({
  ...(process.env["IBUS_WEB_TEST_CACHE_DIR"] ? { cacheDir: process.env["IBUS_WEB_TEST_CACHE_DIR"] } : {}),
  optimizeDeps: { include: ["effect"], exclude: ["@effect/vitest"] },
  server: { headers: crossOriginIsolation },
  test: {
    fileParallelism: false,
    include: ["test/router/{contexts,preedit,surrounding,content-type,switching}.test.ts"],
    browser: browserMode(["chromium", "firefox"], {}),
  },
});
