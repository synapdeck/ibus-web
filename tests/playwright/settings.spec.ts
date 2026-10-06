// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { test, expect, hangul, keyboardSetting, openDemo } from "./fixtures.ts";

test("3-set changes composition immediately, persists on reload and reaches another live tab", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  await openDemo(other);
  for (const tab of [page, other]) {
    await hangul(tab);
    await tab.keyboard.type("gks");
    await tab.locator("h1").click();
    await expect(tab.locator("#input")).toHaveValue("한");
  }
  await keyboardSetting(page, "3f");
  await expect(other.locator("#setting-hangul-keyboard")).toHaveValue("3f");
  const compositions: string[] = [];
  for (const tab of [page, other]) {
    await tab.locator("#input").click();
    await expect(tab.locator("#mode")).toHaveText("한");
    await tab.keyboard.type("gks");
    await tab.locator("h1").click();
    const value = (await tab.locator("#input").inputValue()).slice(1);
    expect(value).not.toBe("한");
    expect(value).not.toMatch(/[a-z]/i);
    expect(value.length).toBeGreaterThan(0);
    compositions.push(value);
  }
  expect(compositions[1]).toBe(compositions[0]);
  await page.reload();
  await expect(page.locator("#engine")).toHaveText("ready");
  await expect(page.locator("#setting-hangul-keyboard")).toHaveValue("3f");
  await hangul(page);
  await page.keyboard.type("gks");
  await page.locator("h1").click();
  await expect(page.locator("#input")).toHaveValue(compositions[0]!);
  await other.close();
});
