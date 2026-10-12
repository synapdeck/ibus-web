// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { cpus } from "node:os";
import type { Page } from "playwright/test";
import { expect, openDemo, test } from "./fixtures.ts";
import { candidateText, candidates, field, probe, rime, selectEngine } from "./rime.ts";

declare global {
  interface Window {
    installShown: string[];
  }
}

// An engine's first selection downloads and installs its dictionaries, and the
// module's first start runs Rime's maintenance.
test.describe.configure({ timeout: 300_000 });

const picker = (page: Page) => page.locator("#engine-picker");
const install = (page: Page) => page.locator("#install");
const setting = (page: Page, name: string) => page.locator(`#settings [name='${name}']`);
const settingsReady = (page: Page) =>
  expect(page.locator("#settings-state")).toHaveText("Settings ready; changes save automatically.");
const firstCandidate = async (page: Page) => candidateText(await candidates(page).first().textContent());

// Keys typed at once reach Rime one by one, and the panel draws each one's
// candidates in turn, so a list is the last key's once the auxiliary text
// holds every key and the list stops changing.
const typeAndSettle = async (page: Page, keys: string) => {
  await page.keyboard.type(keys);
  await expect(page.locator(".ibus-panel [data-auxiliary]")).toHaveText(new RegExp(`^${keys}`));
  let shown = "";
  await expect
    .poll(
      async () => {
        const previous = shown;
        shown = (await candidates(page).allTextContents()).join("\n");
        return shown !== "" && shown === previous;
      },
      { intervals: [200] },
    )
    .toBe(true);
};

// Every text the Data field shows from now on.
const watchInstall = (page: Page) =>
  install(page).evaluate((element) => {
    const shown: string[] = [];
    window.installShown = shown;
    new MutationObserver(() => shown.push(element.textContent ?? "")).observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
const installShown = (page: Page) => page.evaluate(() => window.installShown);

// The groups follow from the manifest's languages by the page's rule, worked
// out again here in the browser from the manifest the page serves.
test("the picker lists Rime's engines under their languages", async ({ page }) => {
  const option = (group: string, engine: string) =>
    picker(page).locator(`optgroup[label='${group}'] option[data-engine='${engine}']`);
  await expect(option("rime · Chinese", "rime:rime_ice")).toHaveText("雾凇拼音 (Pinyin, simplified)");
  await expect(option("rime · Cantonese", "rime:jyut6ping3")).toHaveCount(1);
  // Chromium's language names have none for Wu Chinese, so its group is labelled with the code.
  const wu = await page.evaluate(() => new Intl.DisplayNames(["en"], { type: "language" }).of("wuu"));
  expect(["Wu Chinese", "wuu"]).toContain(wu);
  await expect(option(`rime · ${wu}`, "rime:wugniu")).toHaveCount(1);

  const groups = await page.evaluate(async () => {
    const manifest = (await (await fetch("/ibus-web/modules/rime/manifest.json")).json()) as {
      engines: { name: string; languages: string[] }[];
    };
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    const language = (code: string | undefined) => {
      if (code === undefined) return "";
      try {
        const { language } = new Intl.Locale(code);
        return language === "und" ? "" : language;
      } catch {
        return code;
      }
    };
    return manifest.engines.map(({ name, languages }) => {
      const code = language(languages[0]);
      return { name, group: code === "" ? "rime" : `rime · ${names.of(code) ?? code}` };
    });
  });
  expect(groups.length).toBeGreaterThan(12);
  for (const { name, group } of groups) await expect(option(group, name)).toHaveCount(1);
  await expect(picker(page).locator("option[data-engine^='rime:']")).toHaveCount(groups.length);
});

test("rime_ice's dictionaries install on its first selection and not on its second", async ({
  page,
  browser,
  browserName,
}) => {
  await watchInstall(page);
  const begin = Date.now();
  await selectEngine(page, "rime:rime_ice");
  await expect(install(page)).toHaveText(/^Installed rime:rime_ice: \d+\.\d MB$/, { timeout: 240_000 });
  const milliseconds = Date.now() - begin;
  expect((await installShown(page)).some((text) => text.startsWith("Installing rime:rime_ice: "))).toBe(true);
  console.log(
    JSON.stringify({
      metric: "rime_ice, picker to its data installed",
      browser: browserName,
      version: browser.version(),
      milliseconds,
      installed: await install(page).textContent(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
    }),
  );
  await probe(page, "nihao ", "你好");

  await picker(page).selectOption({ label: "Hangul" });
  await expect(page.locator("#engine")).toHaveText("ready");
  await watchInstall(page);
  await rime(page, "rime:rime_ice");
  expect(await installShown(page)).toEqual([]);
});

test("rime_ice converts a phrase whole and commits it on Space", async ({ page }) => {
  await rime(page, "rime:rime_ice");
  await page.keyboard.type("nihaoshijie");
  await expect(field(page)).toHaveValue("");
  await expect.poll(() => firstCandidate(page)).toMatch(/^你好世界(\s|$)/);
  await page.keyboard.press("Space");
  await expect(field(page)).toHaveValue("你好世界");
});

test("Cangjie 5 lists 日 first for a and commits it on Space", async ({ page }) => {
  await rime(page, "rime:cangjie5");
  await page.keyboard.type("a");
  await expect.poll(() => firstCandidate(page)).toMatch(/^日(\s|$)/);
  await page.keyboard.press("Space");
  await expect(field(page)).toHaveValue("日");
});

// luna_pinyin starts traditional. The page draws Rime's switch itself and sets
// it through the panel action, with the panel's properties not placed.
test("the page's own switch turns luna_pinyin's simplification on", async ({ page }) => {
  await openDemo(page, "/?properties=page");
  await expect(page.locator(".ibus-panel-properties")).toHaveCount(0);
  await rime(page, "rime:luna_pinyin");
  const simplification = page.locator("#switches [data-switch='rime:option:simplification']");
  await expect(simplification).toHaveAttribute("aria-checked", "false");
  await simplification.click();
  await expect(simplification).toHaveAttribute("aria-checked", "true");
  await page.keyboard.type("zhongguo ");
  await expect(field(page)).toHaveValue("中国");
});

test("a candidate chosen below the first comes first after a reload", async ({ page }) => {
  await rime(page, "rime:rime_ice");
  await typeAndSettle(page, "shi");
  await expect(candidates(page).nth(2)).toBeVisible();
  const chosen = candidateText(await candidates(page).nth(2).textContent());
  expect(chosen).not.toBe(await firstCandidate(page));
  await candidates(page).nth(2).click();
  await expect(field(page)).not.toHaveValue("");
  expect(chosen.startsWith(await field(page).inputValue())).toBe(true);

  // Rime keeps a commit's learning open, to be undone, until the next key it
  // doesn't handle, and a reload ends the Worker without saving it.
  await page.keyboard.press("Escape");

  // A Worker's Web Locks outlive its page by up to some 2 s in Chromium, and a
  // host that started then would mount Rime's files read-only.
  await page.reload();
  await expect(page.locator("#engine")).toHaveText("ready");
  await page.evaluate(() => navigator.locks.request("ibus-web:writer:rime", () => undefined));
  await watchInstall(page);
  await rime(page, "rime:rime_ice");
  await expect(page.locator("#storage")).toHaveText("persistent (writable)");
  await page.keyboard.type("shi");
  await expect.poll(() => firstCandidate(page)).toBe(chosen);
  expect(await installShown(page)).toEqual([]);
});

test("the settings form holds Rime's settings and the selected engine's switches, and the page size reaches the panel", async ({
  page,
}) => {
  await rime(page, "rime:rime_ice");
  await settingsReady(page);
  await expect(setting(page, "page-size")).toHaveCount(1);
  await expect(setting(page, "full-shape")).toHaveCount(1);
  await expect(setting(page, "simplification")).toHaveCount(1);

  await setting(page, "page-size").fill("3");
  await page.locator("h1").click();
  await expect(page.locator("#settings-state")).toHaveText("Saved; applies live and across tabs.");

  // The change redeploys Rime's configuration, and keys pass through until
  // that ends.
  await expect(async () => {
    await field(page).click();
    await page.keyboard.press("Escape");
    await field(page).fill("");
    await page.keyboard.type("shi");
    await expect(candidates(page)).toHaveCount(3, { timeout: 2_000 });
  }).toPass({ timeout: 120_000 });
});
