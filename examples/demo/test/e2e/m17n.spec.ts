// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { cpus } from "node:os";
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

// A context takes configured values when it resets, which focus-out and Reset
// do and focus-in does not. Saving moves focus off the field before the value
// is stored, so that focus-out resets with the old value; once the save is
// confirmed, focusing the field and leaving it again resets with the new one.
// Typing stays native until the refocused field's context is ready, which the
// panel's indicator shows by getting its label back after focus-out cleared it.
test("a variable saved in the form reaches the field after it loses focus", async ({ page }) => {
  const indicator = page.locator("[data-indicator]");
  await pick(page, "Vietnamese (telex)", "hoaf ", "hòa ");
  await settingsReady(page);
  await setting(page, "tone-mark-on-last").fill("1");
  await page.locator("h1").click();
  await expect(page.locator("#settings-state")).toHaveText("Saved; applies live and across tabs.");

  await field(page).click();
  await expect(indicator).toHaveText("Input method");
  await page.locator("h1").click();
  await expect(indicator).toHaveText("");
  await field(page).click();
  await expect(indicator).toHaveText("Input method");
  await page.keyboard.type("hoaf ");
  await expect(field(page)).toHaveValue("hoà ");
});

// The first start installs the data; a restarted Worker reads it, and every
// input method m17n lists, from IndexedDB. Timed in the page, from the click
// to the module reading ready again.
test("the module starts again from IndexedDB", async ({ page, browser, browserName }) => {
  test.setTimeout(120_000);
  await pick(page, "Hindi (inscript)", "k", "क");
  await expect(page.locator("#engine")).toHaveText("ready");
  await expect(page.locator("#storage")).toHaveText("persistent (writable)");

  const milliseconds = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const state = document.querySelector("#engine")!;
        let left = false;
        const begin = performance.now();
        new MutationObserver((_, observer) => {
          if (state.textContent !== "ready") left = true;
          else if (left) {
            observer.disconnect();
            resolve(performance.now() - begin);
          }
        }).observe(state, { childList: true, characterData: true, subtree: true });
        document.querySelector<HTMLButtonElement>("#restart")!.click();
      }),
  );
  console.log(
    JSON.stringify({
      metric: "m17n start from IndexedDB, Restart module to ready",
      browser: browserName,
      version: browser.version(),
      milliseconds,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
    }),
  );
  expect(milliseconds).toBeGreaterThan(0);
  await probe(page, "k", "क");
});
