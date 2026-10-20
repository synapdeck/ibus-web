// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { browserMode, crossOriginIsolation, serveDirs, servePlugin } from "@ibus-web/test-programs/vitest";
const fixturePath = process.env["IBUS_WEB_WORKER_HOST_TESTS"];
const hangulPath = process.env["IBUS_WEB_HANGUL_MANIFEST"];
const fixtures =
  fixturePath === undefined
    ? undefined
    : (JSON.parse(readFileSync(fixturePath, "utf8")) as {
        runtimes: Record<string, string>;
        engines: { recoverable: string };
      });
const prefix = "/@ibus-web-core/";
const jsDir = fileURLToPath(new URL("./test/browser/fixtures/js-module/", import.meta.url));
const dirs =
  fixtures && hangulPath
    ? {
        js: jsDir,
        ...fixtures.runtimes,
        recoverable: fixtures.engines.recoverable,
        hangul: dirname(hangulPath),
        host: fileURLToPath(new URL("../worker-host/dist/worker/", import.meta.url)),
      }
    : {};
export default defineConfig({
  ...(process.env["IBUS_WEB_TEST_CACHE_DIR"] ? { cacheDir: process.env["IBUS_WEB_TEST_CACHE_DIR"] } : {}),
  optimizeDeps: { include: ["effect"], exclude: ["@effect/vitest"] },
  plugins: [servePlugin("ibus-web-core", serveDirs(prefix, dirs))],
  server: { headers: crossOriginIsolation },
  test: {
    provide: {
      realHost: {
        hostUrl: `${prefix}host/index.js`,
        runtimes: Object.keys(fixtures?.runtimes ?? {}).map((name) => ({
          name,
          url: `${prefix}${name}/ibus-runtime.js`,
        })),
        hangulUrl: `${prefix}hangul/manifest.json`,
        recoverableUrl: `${prefix}recoverable/manifest.json`,
        jsUrl: `${prefix}js/manifest.json`,
      },
    },
    testTimeout: 30_000,
    fileParallelism: false,
    include: ["test/browser/**/*.test.ts"],
    browser: browserMode(["chromium", "firefox"], {}),
  },
});
