// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { test, expect, openDemo } from "./fixtures.ts";
import { hangul, hangulEngine, keyboardSetting } from "./hangul.ts";

test.beforeEach(async ({ page }) => {
  await expect(page.locator("#setting-hangul-keyboard")).toHaveValue("2");
});

test("trusted composition keeps preedit outside value and emits input only for commits", async ({ page }) => {
  await page.locator("#input").evaluate((element) => {
    element.setAttribute("data-inputs", "[]");
    element.addEventListener("input", () => {
      const values = JSON.parse(element.getAttribute("data-inputs")!) as string[];
      values.push((element as HTMLTextAreaElement).value);
      element.setAttribute("data-inputs", JSON.stringify(values));
    });
  });
  await hangul(page);
  await page.keyboard.type("gks");
  const preedit = page.locator("[data-ibus-preedit]").filter({ hasText: "한" });
  await expect(preedit).toBeVisible();
  await expect(page.locator("#input")).toHaveValue("");
  await expect(page.locator("#input")).toHaveAttribute("data-inputs", "[]");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const node = [...document.querySelectorAll("[data-ibus-preedit]")].find((element) =>
          element.textContent?.includes("한"),
        );
        if (!node) return false;
        const bounds = node.getBoundingClientRect();
        const field = document.querySelector("#input")!.getBoundingClientRect();
        return (
          bounds.width > 0 &&
          bounds.height > 0 &&
          bounds.x >= field.x &&
          bounds.x < field.right &&
          bounds.y >= field.y &&
          bounds.y < field.bottom
        );
      }),
    )
    .toBe(true);
  await page.keyboard.type("rmf");
  await expect(page.locator("#input")).toHaveValue("한");
  await page.keyboard.press("Space");
  await expect(page.locator("#input")).toHaveValue("한글 ");
  const commits = JSON.parse((await page.locator("#input").getAttribute("data-inputs"))!) as string[];
  expect(commits.length).toBeGreaterThan(0);
  expect(commits.every((value) => value.length > 0 && "한글 ".startsWith(value))).toBe(true);
  expect(commits.at(-1)).toBe("한글 ");
});

test("blur commits the current syllable", async ({ page }) => {
  await hangul(page);
  await page.keyboard.type("gks");
  await expect(page.locator("#input")).toHaveValue("");
  await page.locator("#single-line").click();
  await expect(page.locator("#input")).toHaveValue("한");
});

test("one native undo removes the last focused commit", async ({ page }) => {
  await hangul(page);
  await page.keyboard.type("gks");
  await page.keyboard.press("Shift+Space");
  await expect(page.locator("#input")).toHaveValue("한");
  await page.keyboard.press((await page.evaluate(() => navigator.platform.startsWith("Mac"))) ? "Meta+z" : "Control+z");
  await expect(page.locator("#input")).toHaveValue("");
  await page.locator("#enabled").uncheck();
  await page.locator("#single-line").click();
  await page.keyboard.type("native");
  await page.keyboard.press((await page.evaluate(() => navigator.platform.startsWith("Mac"))) ? "Meta+z" : "Control+z");
  await expect(page.locator("#single-line")).toHaveValue("");
});

test("Hanja clicks and digits select the current second page", async ({ page }) => {
  await hangul(page);
  const options = page.locator(".ibus-panel [data-candidate]");
  await page.keyboard.type("gks");
  await page.keyboard.press("F9");
  await expect(options.first()).toBeVisible();
  const firstPage = await options.allTextContents();
  await page.keyboard.press("PageDown");
  await expect.poll(() => options.allTextContents()).not.toEqual(firstPage);
  const second = (await options.first().innerText()).replace(/^\s*\d+[.\s]*/, "").trim();
  await options.first().click();
  await expect(page.locator("#input")).toHaveValue(second);
  await page.keyboard.type("gks");
  await page.keyboard.press("F9");
  await expect(options.first()).toBeVisible();
  await page.keyboard.press("PageDown");
  await expect.poll(() => options.allTextContents()).not.toEqual(firstPage);
  await page.keyboard.press("1");
  await expect(page.locator("#input")).toHaveValue(second + second);
});

test("attached password surface retains native Latin input", async ({ page }) => {
  // Reuse the production attachment while exercising its dynamic content-type guard.
  await page.locator("#single-line").evaluate((element) => element.setAttribute("type", "password"));
  await page.locator("#single-line").click();
  await page.keyboard.press("Shift+Space");
  await page.keyboard.type("gksrmf");
  await expect(page.locator("#single-line")).toHaveValue(" gksrmf");
  await expect(page.locator("[data-ibus-preedit]").filter({ hasText: /[가-힣]/ })).toHaveCount(0);
});

test("restart recovers the real engine and accepts trusted composition", async ({ page }) => {
  await hangul(page);
  await page.keyboard.type("gks");
  const workers = page.workers().length;
  let startedWorkers = 0;
  page.on("worker", () => startedWorkers++);
  await page.locator("#restart").click();
  await expect.poll(() => startedWorkers).toBeGreaterThan(0);
  expect(workers).toBeGreaterThan(0);
  await expect(page.locator("#restart")).toBeEnabled();
  await expect(page.locator("#engine")).toHaveText("ready");
  await page.locator("#input").click();
  await expect(page.locator("#mode")).toHaveText("EN");
  await page.keyboard.press("Shift+Space");
  await expect(page.locator("#mode")).toHaveText("한");
  await page.keyboard.type("gks");
  await page.locator("h1").click();
  await expect(page.locator("#input")).toHaveValue("한한");
});

test("repeated words stay Hangul across native Space reset boundaries", async ({ page }) => {
  await hangul(page);
  for (const key of "gksrmf ".repeat(10)) {
    const before = await page.evaluate(() =>
      JSON.stringify([
        (document.querySelector("#input") as HTMLTextAreaElement).value,
        ...[...document.querySelectorAll("[data-ibus-preedit]")].map((node) => node.textContent),
      ]),
    );
    await page.keyboard.press(key === " " ? "Space" : key);
    await page.waitForFunction(
      (previous) =>
        JSON.stringify([
          (document.querySelector("#input") as HTMLTextAreaElement).value,
          ...[...document.querySelectorAll("[data-ibus-preedit]")].map((node) => node.textContent),
        ]) !== previous,
      before,
    );
  }
  await expect(page.locator("#input")).toHaveValue("한글 ".repeat(10));
});

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

test("the picker lists Hangul, and Ctrl+Space turns input methods off and back on", async ({ page }) => {
  await expect(page.locator("#engine-picker option:checked")).toHaveText("Hangul");
  await hangul(page);
  await page.keyboard.type("gks");
  await page.keyboard.press("Control+Space");
  await expect(page.locator("#engine-picker")).toHaveValue("");
  await expect(page.locator("#input")).toHaveValue("한");
  await page.keyboard.type("gks");
  await expect(page.locator("#input")).toHaveValue("한gks");
  await expect(page.locator("[data-ibus-preedit]").filter({ hasText: /[가-힣]/ })).toHaveCount(0);
  await page.keyboard.press("Control+Space");
  await expect(page.locator("#engine-picker option:checked")).toHaveText("Hangul");
  await expect(page.locator("#engine")).toHaveText("ready");
});

// A page with its own controls reads the engine's toggles from the panel's
// records and activates them through the panel action, with none of the
// panel's properties placed.
test("the page's own switch turns on Hangul input with the panel's properties not placed", async ({ page }) => {
  await openDemo(page, "/?properties=page");
  await expect(page.locator(".ibus-panel-properties")).toHaveCount(0);
  await expect(page.locator("#engine-picker option:checked")).toHaveAttribute("data-engine", "hangul");
  await hangulEngine(page);
  const mode = page.locator("#switches [data-switch='InputMode']");
  await expect(mode).toHaveAttribute("aria-checked", "false");
  await mode.click();
  await expect(mode).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#mode")).toHaveText("한");
  await page.keyboard.type("gks");
  await page.locator("h1").click();
  await expect(page.locator("#input")).toHaveValue("한");
});
