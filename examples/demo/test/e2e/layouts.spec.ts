// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { Page } from "playwright/test";
import { expect, test } from "./fixtures.ts";
import { hangul } from "./hangul.ts";
import { deadKey, layoutNames, press, pressDead, strokeFor, typeAt, typeOn, type LayoutName } from "./layouts.ts";
import { rime } from "./rime.ts";

// Rime's first selection installs its dictionaries.
test.describe.configure({ timeout: 300_000 });

const field = (page: Page) => page.locator("#input");
const preedit = (page: Page) => page.locator("[data-ibus-preedit]").filter({ hasText: /./ });

// Typing stays native until the module's Worker and the field's context are ready, so the probe repeats until the
// engine alone makes the value. Escape drops whatever an attempt left composing.
const probe = async (page: Page, keys: string, value: string) => {
  await expect(async () => {
    await field(page).click();
    await page.keyboard.press("Escape");
    await field(page).fill("");
    await page.keyboard.type(keys);
    await expect(field(page)).toHaveValue(value, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await field(page).fill("");
};

interface Engine {
  readonly layout: "us" | "default";
  // Selects the engine and leaves the field focused, empty and composing nothing.
  start(page: Page): Promise<void>;
  // A word, in the US layout's characters for a US-layout engine, and the keys that commit it.
  readonly word: string;
  readonly commit: string;
  readonly value: string;
  // What the field holds after an AltGr @ and the commit key.
  readonly at: string;
  // Hangul maps keycodes through its own US keymap, so the layout setting, which chooses keyvals, can't move it.
  readonly keycodes?: true;
}

const engines: Readonly<Record<string, Engine>> = {
  Hangul: {
    layout: "us",
    start: hangul,
    word: "gksrmf",
    commit: "Space",
    value: "한글 ",
    at: "@ ",
    keycodes: true,
  },
  "Rime (luna_pinyin)": {
    layout: "us",
    start: (page) => rime(page, "rime:luna_pinyin"),
    word: "zhongguo",
    commit: "Space",
    value: "中國",
    at: "@",
  },
  Mozc: {
    layout: "default",
    start: async (page) => {
      await page.locator("#engine-picker").selectOption({ label: "Mozc:あ" });
      await probe(page, "a\n", "あ");
    },
    word: "kanji",
    commit: "Enter",
    value: "かんじ",
    at: "＠",
  },
  "m17n (Vietnamese telex)": {
    layout: "default",
    start: async (page) => {
      await page.locator("#engine-picker").selectOption({ label: "Vietnamese (telex)" });
      await probe(page, "vieetj ", "việt ");
    },
    word: "vieetj",
    commit: "Space",
    value: "việt ",
    at: "@ ",
  },
  "table (LaTeX)": {
    layout: "default",
    start: async (page) => {
      await page.locator("#engine-picker").selectOption({ label: "LaTeX" });
      await probe(page, "\\alpha ", "α");
    },
    word: "\\alpha",
    commit: "Space",
    value: "α",
    at: "@ ",
  },
};

// The field's value is set from the page, not by Playwright's fill: fill("") presses Delete after a select all that
// isn't a key, so a key still queued behind the engine's reply could replay over it. Every step ends with its text
// committed, so this leaves nothing composing; Escape would end Hangul's Hangul mode.
const setValue = (page: Page, value: string) =>
  field(page).evaluate((element: HTMLTextAreaElement, value) => {
    element.value = value;
    element.setSelectionRange(value.length, value.length);
  }, value);
const clear = async (page: Page) => {
  await setValue(page, "");
  await expect(field(page)).toHaveValue("");
  await expect(preedit(page)).toHaveCount(0);
};

// The word typed as the engine reads the layout: by place for a US-layout engine, by character otherwise.
const typeWord = (page: Page, engine: Engine, layout: LayoutName, text: string) =>
  engine.layout === "us" ? typeAt(page, layout, text) : typeOn(page, layout, text);

const layoutSetting = async (page: Page, value: "us" | "default") => {
  await page.locator("#setting-layout").selectOption(value);
  await expect(page.locator("#settings-state")).toHaveText("Saved; applies live and across tabs.");
  await field(page).click();
};

for (const [name, engine] of Object.entries(engines))
  test(`${name} takes typing, AltGr, dead keys and shortcuts from every layout`, async ({ page, browserName }) => {
    await engine.start(page);

    for (const layout of layoutNames)
      await test.step(layout, async () => {
        await clear(page);
        await typeWord(page, engine, layout, engine.word);
        await page.keyboard.press(engine.commit);
        await expect(field(page), "typing").toHaveValue(engine.value);

        await clear(page);
        await press(page, layout, strokeFor(layout, "a"), ["Meta"]);
        await expect(preedit(page), "Meta+A composes nothing").toHaveCount(0);
        await expect(field(page), "Meta+A types nothing").toHaveValue("");

        await setValue(page, "select me");
        await press(page, layout, strokeFor(layout, "a"), ["Control"]);
        await expect
          .poll(
            () =>
              field(page).evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd]),
            { message: "Ctrl+A selects all" },
          )
          .toEqual([0, 9]);
        await page.keyboard.press("End");

        const dead = deadKey(layout);
        if (dead) {
          // A dead key starts the browser's own composition, so it reaches no engine and leaves the engine's alone.
          await clear(page);
          const half = engine.word.length >> 1;
          await typeWord(page, engine, layout, engine.word.slice(0, half));
          await pressDead(page, layout);
          await typeWord(page, engine, layout, engine.word.slice(half));
          await page.keyboard.press(engine.commit);
          await expect(field(page), "a dead key mid-word").toHaveValue(engine.value);
        }

        // Only Firefox's automation can hold AltGraph (see press), and without it an AltGr key is an unmodified one.
        if (strokeFor(layout, "@").altGr && browserName === "firefox") {
          await clear(page);
          await press(page, layout, strokeFor(layout, "@"));
          await page.keyboard.press(engine.commit);
          await expect(field(page), "AltGr").toHaveValue(engine.at);
        }

        // Set to default, a US-layout engine takes the characters the keys show, unless it reads keycodes.
        if (engine.layout === "us" && layout !== "us") {
          await layoutSetting(page, "default");
          await clear(page);
          await (engine.keycodes ? typeAt : typeOn)(page, layout, engine.word);
          await page.keyboard.press(engine.commit);
          await expect(field(page), "the layout setting at default").toHaveValue(engine.value);
          await layoutSetting(page, "us");
        }
      });
  });
