// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { Page } from "playwright/test";
import { expect, test } from "./fixtures.ts";

const field = (page: Page) => page.locator("#input");
const picker = (page: Page) => page.locator("#engine-picker");
const setting = (page: Page, name: string) => page.locator(`#settings [name='${name}']`);

// Typing stays native until the module's Worker and the field's context are
// ready, and a failed attempt can leave a composition that emptying the field
// commits, so attempts repeat until one starts clean and the engine alone
// makes the value.
const probe = async (page: Page, keys: string, value: string) => {
  await expect(async () => {
    await field(page).click();
    await field(page).fill("");
    await page.keyboard.type(keys);
    await expect(field(page)).toHaveValue(value, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await field(page).fill("");
};
const pick = async (page: Page, label: string, keys: string, value: string) => {
  await picker(page).selectOption({ label });
  await probe(page, keys, value);
};
const settingsReady = (page: Page) =>
  expect(page.locator("#settings-state")).toHaveText("Settings ready; changes save automatically.");

test("the picker lists m17n's engines under their languages", async ({ page }) => {
  const option = (group: string, label: RegExp) =>
    picker(page).locator(`optgroup[label='${group}'] option`).filter({ hasText: label });
  await expect(option("m17n · Hindi", /^Hindi \(inscript\)$/)).toHaveCount(1);
  await expect(option("m17n · Vietnamese", /^Vietnamese \(telex\)$/)).toHaveCount(1);
  await expect(option("m17n · Thai", /^Thai \(kesmanee\)$/)).toHaveCount(1);
  await expect(option("m17n", /^latn-post$/)).toHaveCount(1);
});

test("Hindi (inscript) types Devanagari from its keys", async ({ page }) => {
  await pick(page, "Hindi (inscript)", "k", "क");
  await page.keyboard.type("ke");
  await expect(field(page)).toHaveValue("का");
});

test("Vietnamese (telex) composes việt and commits it on Space", async ({ page }) => {
  await pick(page, "Vietnamese (telex)", "vieetj ", "việt ");
  await page.keyboard.type("vieetj");
  await expect(page.locator("[data-ibus-preedit]").filter({ hasText: "iệt" })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(field(page)).toHaveValue("việt ");
});

// The consonant is the field's own text, which reaches the engine only as
// surrounding text; kesmanee refuses a tone mark with nothing before it.
test("Thai (kesmanee) puts a tone mark on the field's consonant", async ({ page }) => {
  await picker(page).selectOption({ label: "Thai (kesmanee)" });
  await expect(async () => {
    await field(page).click();
    await field(page).fill("ก");
    await page.keyboard.type("h");
    await expect(field(page)).toHaveValue("ก้", { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
});

test("the settings form shows the selected engine's own settings and the panel's", async ({ page }) => {
  await pick(page, "Vietnamese (telex)", "vieetj ", "việt ");
  await settingsReady(page);
  await expect(setting(page, "use-us-layout")).toHaveCount(1);
  await expect(setting(page, "tone-mark-on-last")).toHaveCount(1);
  await expect(setting(page, "lookup-table-orientation")).toHaveCount(2);

  await pick(page, "Hindi (inscript)", "k", "क");
  await settingsReady(page);
  await expect(setting(page, "use-us-layout")).toHaveCount(1);
  await expect(setting(page, "tone-mark-on-last")).toHaveCount(0);
  await expect(setting(page, "lookup-table-orientation")).toHaveCount(2);
});

// The textarea's context was made before the change; it takes the value when
// focus-out resets it, which clicking away from the field to save does.
test("a variable saved in the form reaches the field at its next focus", async ({ page }) => {
  await pick(page, "Vietnamese (telex)", "hoaf ", "hòa ");
  await settingsReady(page);
  await setting(page, "tone-mark-on-last").fill("1");
  await page.locator("h1").click();
  await expect(page.locator("#settings-state")).toHaveText("Saved; applies live and across tabs.");

  await probe(page, "hoaf ", "hoà ");
});
