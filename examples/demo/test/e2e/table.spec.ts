// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { Page } from "playwright/test";
import { expect, test } from "./fixtures.ts";

type Engine = "LaTeX" | "X-SAMPA";

// A composition each engine makes at once, and what it leaves in the field.
const probes: Record<Engine, { keys: string; value: string }> = {
  LaTeX: { keys: "\\alpha ", value: "α" },
  "X-SAMPA": { keys: "S@ ", value: "ʃə " },
};

const field = (page: Page) => page.locator("#input");

// Typing stays native until the module's Worker and the field's context are
// ready, so the probe is retried until the engine makes it. Escape commits
// whatever a half-native attempt left composing, and the field is emptied
// after it.
const pick = async (page: Page, engine: Engine) => {
  await page.locator("#engine-picker").selectOption({ label: engine });
  const { keys, value } = probes[engine];
  await expect(async () => {
    await field(page).click();
    await page.keyboard.press("Escape");
    await field(page).fill("");
    await page.keyboard.type(keys);
    await expect(field(page)).toHaveValue(value, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await field(page).fill("");
};

test("LaTeX turns \\alpha and Space into α", async ({ page }) => {
  await pick(page, "LaTeX");
  await page.keyboard.type("\\alpha");
  await expect(page.locator("[data-ibus-preedit]").filter({ hasText: "\\alpha" })).toBeVisible();
  await expect(page.locator(".ibus-panel [data-candidate]").first()).toContainText("α \\alpha");
  await expect(field(page)).toHaveValue("");
  await page.keyboard.press("Space");
  await expect(field(page)).toHaveValue("α");
});

test("LaTeX commits \\to before the comma that ends it", async ({ page }) => {
  await pick(page, "LaTeX");
  await page.keyboard.type("\\to,");
  await expect(field(page)).toHaveValue("→,");
});

test("X-SAMPA turns S@ and Space into ʃə", async ({ page }) => {
  await pick(page, "X-SAMPA");
  await page.keyboard.type("S@");
  await page.keyboard.press("Space");
  await expect(field(page)).toHaveValue("ʃə ");
});

test("switching between LaTeX and X-SAMPA keeps the module's Worker", async ({ page }) => {
  // The demo opens on Hangul, whose Worker already exists, so only Workers
  // created from the first table selection onward are counted.
  const hosts: string[] = [];
  page.on("worker", (worker) => {
    if (new URL(worker.url()).pathname.endsWith("/host/worker/index.js")) hosts.push(worker.url());
  });
  await pick(page, "LaTeX");
  expect(hosts).toHaveLength(1);
  await pick(page, "X-SAMPA");
  await pick(page, "LaTeX");
  await page.keyboard.type("\\to,");
  await expect(field(page)).toHaveValue("→,");
  expect(hosts).toHaveLength(1);
});

test("deselecting gives plain input", async ({ page }) => {
  await pick(page, "X-SAMPA");
  await page.keyboard.press("Control+Space");
  await expect(page.locator("#engine-picker")).toHaveValue("");
  await page.keyboard.type("S@ ");
  await expect(field(page)).toHaveValue("S@ ");
});

// The engines' languages are und-Zmth and und-fonipa, which name no language,
// so the module stays one group under its own name.
test("the picker lists the table engines in one group under the module's name", async ({ page }) => {
  const group = page.locator("#engine-picker optgroup").filter({ has: page.locator("option", { hasText: "LaTeX" }) });
  await expect(group).toHaveCount(1);
  await expect(group.locator("option", { hasText: "X-SAMPA" })).toHaveCount(1);
  expect(await group.getAttribute("label")).not.toContain("·");
});

test("the settings form follows the selected module", async ({ page }) => {
  const picker = page.locator("#engine-picker");
  const orientation = page.locator("#setting-lookup-table-orientation");
  const hangulKeyboard = page.locator("#setting-hangul-keyboard");

  await picker.selectOption({ label: "LaTeX" });
  await expect(orientation).toBeVisible();
  await expect(hangulKeyboard).toHaveCount(0);

  await picker.selectOption({ label: "Hangul" });
  await expect(hangulKeyboard).toBeVisible();

  await picker.selectOption({ label: "LaTeX" });
  await expect(orientation).toBeVisible();
  await expect(hangulKeyboard).toHaveCount(0);
});
