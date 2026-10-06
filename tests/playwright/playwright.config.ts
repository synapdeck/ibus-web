// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { defineConfig } from "playwright/test";
import { resolve } from "node:path";
const page = process.env["IBUS_WEB_DEMO_PAGE"];
if (!page) throw new Error("IBUS_WEB_DEMO_PAGE must name the production demo; run nix build .#demo first.");
const port = process.env["IBUS_WEB_DEMO_PORT"] ?? "5190";
if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error("Invalid preview port");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export default defineConfig({
  testDir: ".",
  testMatch: process.env["IBUS_WEB_KEYSTROKE_BENCH"] === "1" ? "keystroke.bench.ts" : "*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: process.env["IBUS_WEB_KEYSTROKE_BENCH"] === "1" ? 1 : 3,
  fullyParallel: false,
  retries: 0,
  outputDir: process.env["IBUS_WEB_TEST_OUTPUT"] ?? "/tmp/ibus-web-playwright",
  reporter: [
    ["list"],
    ["json", { outputFile: process.env["IBUS_WEB_TEST_REPORT"] ?? "/tmp/ibus-web-playwright.json" }],
  ],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  projects: ["chromium", "firefox", "webkit"].map((name) => ({
    name,
    use: {
      browserName: name as "chromium" | "firefox" | "webkit",
      launchOptions: { chromiumSandbox: process.env["IBUS_WEB_CHROMIUM_SANDBOX"] !== "0" },
    },
  })),
  webServer: {
    command: `${quote(process.execPath)} node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port} --strictPort --outDir ${quote(resolve(page))}`,
    cwd: resolve(import.meta.dirname, "../../examples/hangul"),
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
