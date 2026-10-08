// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, type Page } from "playwright/test";

export async function hangul(page: Page) {
  await page.locator("#input").click();
  await expect(page.locator("#mode")).toHaveText("EN");
  await page.keyboard.press("Shift+Space");
  await expect(page.locator("#mode")).toHaveText("한");
}

export async function keyboardSetting(page: Page, value: string) {
  await page.locator("#setting-hangul-keyboard").fill(value);
  await page.locator("h1").click();
  await expect(page.locator("#settings-state")).toContainText("Saved");
  await expect(page.locator("#setting-hangul-keyboard")).toBeEnabled();
}
