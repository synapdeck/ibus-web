// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, type Page } from "playwright/test";

export const field = (page: Page) => page.locator("#input");
export const candidates = (page: Page) => page.locator(".ibus-panel [data-candidate]");

// A candidate's button reads its label, a space and the candidate.
export const candidateText = (button: string | null) => (button ?? "").slice((button ?? "").indexOf(" ") + 1);

export async function selectEngine(page: Page, engine: string) {
  const value = await page.locator(`#engine-picker option[data-engine='${engine}']`).getAttribute("value");
  await page.locator("#engine-picker").selectOption(value!);
}

// Typing stays native until the module's Worker, the engine's data and the
// field's context are ready, and keys pass through while Rime's maintenance
// runs, so attempts repeat until Rime alone makes the value. Escape drops
// whatever an attempt left composing.
export async function probe(page: Page, keys: string, value: string) {
  await expect(async () => {
    await field(page).click();
    await page.keyboard.press("Escape");
    await field(page).fill("");
    await page.keyboard.type(keys);
    await expect(field(page)).toHaveValue(value, { timeout: 2_000 });
  }).toPass({ timeout: 120_000 });
  await field(page).fill("");
}

// For each engine the tests type with, keys whose first candidate the Space commits.
const probes: Readonly<Record<string, readonly [string, string]>> = {
  "rime:rime_ice": ["nihao ", "你好"],
  "rime:luna_pinyin": ["zhongguo ", "中國"],
  "rime:cangjie5": ["a ", "日"],
};

// The engine selected and typing, with the field focused and empty.
export async function rime(page: Page, engine: string) {
  await selectEngine(page, engine);
  const [keys, value] = probes[engine]!;
  await probe(page, keys, value);
}
