// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { browserMode, crossOriginIsolation, serveDirs, servePlugin } from "@ibus-web/test-programs/vitest";
export default defineConfig({
  ...(process.env["IBUS_WEB_TEST_CACHE_DIR"] ? { cacheDir: process.env["IBUS_WEB_TEST_CACHE_DIR"] } : {}),
  // The host's scripts as the package ships them, the storage Worker's among them.
  plugins: [
    servePlugin(
      "ibus-web-facade",
      serveDirs("/@ibus-web-facade/", { host: fileURLToPath(new URL("./dist/host/", import.meta.url)) }),
    ),
  ],
  server: { headers: crossOriginIsolation },
  test: {
    fileParallelism: false,
    projects: [
      { extends: true, test: { name: "node", include: ["test/node/**/*.test.ts"] } },
      {
        extends: true,
        test: { include: ["test/browser/**/*.test.ts"], browser: browserMode(["chromium", "firefox"], {}) },
      },
    ],
  },
});
