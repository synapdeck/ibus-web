// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, type Page } from "playwright/test";

// Hangul selected and the field focused, in its English mode.
export async function hangulEngine(page: Page) {
  await page.locator("#engine-picker").selectOption({ label: "Hangul" });
  await expect(page.locator("#engine")).toHaveText("ready");
  await expect(page.locator("#settings-state")).toHaveText("Settings ready; changes save automatically.");
  await page.locator("#input").click();
  await expect(page.locator("#mode")).toHaveText("EN");
}

export async function hangul(page: Page) {
  await hangulEngine(page);
  await page.keyboard.press("Shift+Space");
  await expect(page.locator("#mode")).toHaveText("한");
}

export async function keyboardSetting(page: Page, value: string) {
  await page.locator("#setting-hangul-keyboard").fill(value);
  await page.locator("h1").click();
  await expect(page.locator("#settings-state")).toContainText("Saved");
  await expect(page.locator("#setting-hangul-keyboard")).toBeEnabled();
}
