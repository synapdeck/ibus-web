// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { Page } from "playwright/test";
import { expect, test } from "./fixtures.ts";

const field = (page: Page) => page.locator("#input");

// Typing stays native until the module's Worker and the field's context are
// ready, so the probe is retried until Mozc composes it. Escape drops
// whatever a half-native attempt left composing, and the field is emptied
// after it.
const pick = async (page: Page) => {
  await page.locator("#engine-picker").selectOption({ label: "Mozc:あ" });
  await expect(async () => {
    await field(page).click();
    await page.keyboard.press("Escape");
    await field(page).fill("");
    await page.keyboard.type("a");
    await page.keyboard.press("Enter");
    await expect(field(page)).toHaveValue("あ", { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await field(page).fill("");
};

test("Mozc composes romaji as hiragana, converts it on Space and commits it on Enter", async ({ page }) => {
  await pick(page);
  await page.keyboard.type("kyouhaiitenkidesu");
  await expect(page.locator("[data-ibus-preedit]").filter({ hasText: "きょうはいいてんきです" })).toBeVisible();
  await expect(field(page)).toHaveValue("");

  await page.keyboard.press("Space");
  await expect(page.locator("[data-ibus-preedit]").filter({ hasText: "今日はいい天気です" })).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(field(page)).toHaveValue("今日はいい天気です");
});

test("a second Space opens the candidate panel", async ({ page }) => {
  await pick(page);
  await page.keyboard.type("kanji");
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
  await expect(page.locator(".ibus-panel [data-candidate]").filter({ hasText: "漢字" })).toBeVisible();
});

test("the direct-input engine leaves typing to the browser", async ({ page }) => {
  await page.locator("#engine-picker").selectOption({ label: "Mozc:A_" });
  await field(page).click();
  await page.keyboard.type("abc");
  await expect(field(page)).toHaveValue("abc");
});

test("the settings form's punctuation choice reaches Mozc", async ({ page }) => {
  await pick(page);
  await page.locator("#setting-punctuation-method").selectOption("comma-period");
  await expect(page.locator("#settings-state")).toHaveText("Saved; applies live and across tabs.");
  await field(page).click();
  await page.keyboard.type("a,");
  await page.keyboard.press("Enter");
  await expect(field(page)).toHaveValue("あ，");
});
