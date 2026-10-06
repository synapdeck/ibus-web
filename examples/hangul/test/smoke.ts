// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";

const port = process.env["IBUS_WEB_DEMO_PORT"] ?? "5187";
const server = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    port,
    "--strictPort",
    "--outDir",
    process.env["IBUS_WEB_DEMO_PAGE"]!,
  ],
  { stdio: ["ignore", "pipe", "inherit"] },
);
try {
  await new Promise<void>((resolve, reject) => {
    server.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes(`127.0.0.1:${port}`)) resolve();
    });
    server.once("exit", (code) => reject(new Error(`Preview exited: ${code}`)));
    server.once("error", reject);
  });
  const browser = await chromium.launch({ chromiumSandbox: process.env["IBUS_WEB_CHROMIUM_SANDBOX"] !== "0" });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    const archives: { encoding: string | undefined; type: string | undefined }[] = [];
    page.on("response", (response) => {
      if (response.url().endsWith(".tar.br"))
        archives.push({
          encoding: response.headers()["content-encoding"],
          type: response.headers()["content-type"],
        });
    });
    page.on("pageerror", (error) => errors.push(error.message));
    const openedAt = performance.now();
    await page.goto(`http://127.0.0.1:${port}`);
    try {
      await page.getByText("ready", { exact: true }).waitFor();
    } catch (cause) {
      console.error(await page.locator("body").innerText());
      throw cause;
    }
    console.log(`Production page ready after ${(performance.now() - openedAt).toFixed(1)} ms (fresh browser context).`);
    assert.equal(await page.evaluate(() => crossOriginIsolated), true);
    const field = page.getByRole("textbox", { name: "Type here" });
    await field.focus();
    await page.waitForFunction(() => document.querySelector("#mode")?.textContent === "EN");
    await field.press("Shift+Space");
    await page.waitForFunction(() => document.querySelector("#mode")?.textContent === "한");
    await field.pressSequentially("gks");
    await page.waitForFunction(() => document.querySelector("[data-ibus-preedit]")?.textContent?.includes("한"));
    assert.equal(await field.inputValue(), "");
    await page.getByRole("textbox", { name: "Single-line input" }).click();
    await page.waitForFunction(() => (document.querySelector("#input") as HTMLTextAreaElement).value === "한");
    assert.equal(await field.inputValue(), "한");
    assert.ok(archives.length > 0);
    for (const archive of archives) {
      assert.equal(archive.encoding, undefined);
      assert.equal(archive.type, "application/octet-stream");
    }
    assert.deepEqual(errors, []);
    console.log(
      "Demo smoke passed: isolated page, actual Worker/runtime/Hangul, trusted typing, isolated preedit and focus commit 한.",
    );
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
  if (server.exitCode === null) await once(server, "exit");
}
