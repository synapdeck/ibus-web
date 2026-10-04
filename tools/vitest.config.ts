// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: process.env["IBUS_WEB_TEST_CACHE_DIR"],
  test: { include: ["cast-audit/**/*.test.ts", "ibus-test/**/*.test.ts", "vendor-inventory/**/*.test.ts"] },
});
