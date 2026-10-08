// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { test as base, expect, type Page } from "playwright/test";
export { expect };
export const test = base.extend<{ healthyDemo: void }>({
  healthyDemo: [
    async ({ page, context }, use) => {
      const errors: string[] = [];
      const observe = (opened: Page) => opened.on("pageerror", (error) => errors.push(error.message));
      observe(page);
      context.on("page", observe);
      await openDemo(page);
      await use();
      expect(errors).toEqual([]);
      await expect(page.locator("#error")).toBeEmpty();
      await expect(page.locator("#log")).not.toContainText("error [");
    },
    { auto: true },
  ],
});
export async function openDemo(page: Page) {
  await page.goto("/");
  await expect(page.locator("#engine")).toHaveText("ready");
  await expect(page.locator("#settings-state")).toHaveText("Settings ready; changes save automatically.");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
}
