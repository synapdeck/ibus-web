// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { Page } from "playwright/test";
import { expect, openDemo, test } from "./fixtures.ts";

const field = (page: Page) => page.locator("#input");
const toggle = (page: Page) => page.locator("#switches [data-switch='pinyin-tones:v-as-u']");

// Typing stays native until the module's Worker and the field's context are
// ready, so a syllable is retried until the engine marks it. Escape commits
// whatever a half-native attempt left composing, and the field is emptied
// after it.
const pinyin = async (page: Page) => {
  await page.locator("#engine-picker").selectOption({ label: "Pinyin (tone numbers)" });
  await expect(async () => {
    await field(page).click();
    await page.keyboard.press("Escape");
    await field(page).fill("");
    await page.keyboard.type("ma3 ");
    await expect(field(page)).toHaveValue("mǎ ", { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await field(page).fill("");
};

test("the picker lists the engine under the module's name", async ({ page }) => {
  const option = page.locator("#engine-picker option", { hasText: /^Pinyin \(tone numbers\)$/ });
  await expect(option).toHaveCount(1);
  await expect(option).toHaveAttribute("data-engine", "pinyin-tones");
  expect(await option.locator("xpath=..").getAttribute("label")).toBe("pinyin-tones");
});

test("ni3 hao3 gives nǐ hǎo, marked while it is typed", async ({ page }) => {
  await pinyin(page);
  await page.keyboard.type("ni3 hao3");
  await expect(page.locator("[data-ibus-preedit]").filter({ hasText: "hǎo" })).toBeVisible();
  await expect(field(page)).toHaveValue("nǐ ");
  await page.keyboard.press("Space");
  await expect(field(page)).toHaveValue("nǐ hǎo ");
});

// The page draws the engine's toggle itself, so its state is read from the
// switch rather than from the panel's own controls.
test("the v-as-u toggle decides whether v is read as ü", async ({ page }) => {
  await openDemo(page, "/?properties=page");
  await pinyin(page);
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.type("lv4 ");
  await expect(field(page)).toHaveValue("lǜ ");

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
  await page.keyboard.type("lv4 ");
  await expect(field(page)).toHaveValue("lǜ lv4 ");

  await page.keyboard.type("nu:3 ");
  await expect(field(page)).toHaveValue("lǜ lv4 nǚ ");
});

test("the settings form shows v-as-u and follows the toggle", async ({ page }) => {
  await openDemo(page, "/?properties=page");
  await pinyin(page);
  const setting = page.locator("#setting-v-as-u");
  await expect(page.locator("#settings-state")).toHaveText("Settings ready; changes save automatically.");
  await expect(setting).toBeChecked();
  await expect(page.locator("#settings label.setting", { has: setting })).toContainText("Read v as ü");

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
  await expect(setting).not.toBeChecked();
});

test("deselecting gives plain input", async ({ page }) => {
  await pinyin(page);
  await page.keyboard.press("Control+Space");
  await expect(page.locator("#engine-picker")).toHaveValue("");
  await page.keyboard.type("ni3 ");
  await expect(field(page)).toHaveValue("ni3 ");
});

test("selecting another module and back keeps the module's Worker", async ({ page }) => {
  // The demo opens on Hangul, whose Worker already exists, so only Workers
  // created from the first pinyin selection onward are counted.
  const hosts: string[] = [];
  page.on("worker", (worker) => {
    if (new URL(worker.url()).pathname.endsWith("/host/worker/index.js")) hosts.push(worker.url());
  });
  await pinyin(page);
  expect(hosts).toHaveLength(1);
  await page.locator("#engine-picker").selectOption({ label: "Hangul" });
  await expect(page.locator("#engine")).toHaveText("ready");
  await pinyin(page);
  await page.keyboard.type("hao3 ");
  await expect(field(page)).toHaveValue("hǎo ");
  expect(hosts).toHaveLength(1);
});
