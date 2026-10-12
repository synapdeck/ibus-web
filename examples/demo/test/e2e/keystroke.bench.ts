// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { cpus, platform, release, arch, totalmem } from "node:os";
import type { Browser, Page } from "playwright/test";
import { test, expect } from "./fixtures.ts";
import { hangul } from "./hangul.ts";
import { candidates, rime } from "./rime.ts";
interface Sample {
  key: string;
  milliseconds: number;
  observation: "handler-return" | "later-observer" | "native-input";
}
declare global {
  interface Window {
    ibusBench: { samples: Sample[]; pending: boolean; error: string | undefined };
  }
}

interface Case {
  readonly engine: string;
  readonly ready: (page: Page) => Promise<void>;
  // Typed round and round, each key once per round.
  readonly sequence: string;
  readonly warmup: number;
  // What the field holds after this many keys of the sequence.
  readonly value: (keys: number) => string;
  readonly after: (page: Page) => Promise<void>;
}

const measure = async (page: Page, browser: Browser, browserName: string, bench: Case) => {
  await bench.ready(page);
  await expect(page.locator("#engine")).toHaveText("ready");
  await page.locator("#input").evaluate((element, keys) => {
    const field = element as HTMLTextAreaElement;
    const snapshot = () =>
      JSON.stringify({
        value: field.value,
        start: field.selectionStart,
        end: field.selectionEnd,
        preedit: [...document.querySelectorAll("[data-ibus-preedit]")].map((node) => ({
          text: node.textContent,
          // Cursor/format attributes belong to preedit; incidental positioning styles do not.
          content: [...node.querySelectorAll("*")].map((child) => [
            child.textContent,
            child.getAttribute("class"),
            child.getAttribute("data-cursor"),
          ]),
        })),
      });
    const state: Window["ibusBench"] = {
      samples: [] as Sample[],
      pending: false,
      error: undefined as string | undefined,
    };
    window.ibusBench = state;
    let active: { start: number; before: string; key: string; handled: boolean; prevented: boolean } | undefined;
    const finish = (observation: Sample["observation"]) => {
      if (!active || snapshot() === active.before) return;
      state.samples.push({ key: active.key, milliseconds: performance.now() - active.start, observation });
      active = undefined;
      state.pending = false;
    };
    new MutationObserver(() => {
      if (active?.handled && active.prevented) finish("later-observer");
    }).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "data-cursor"],
    });
    field.addEventListener("input", () =>
      queueMicrotask(() => {
        if (active?.handled) finish(active.prevented ? "later-observer" : "native-input");
      }),
    );
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.target !== field || !event.isTrusted || !keys.includes(event.key)) return;
        if (active) {
          state.error = "Overlapping measured keydowns";
          return;
        }
        active = { start: performance.now(), before: snapshot(), key: event.key, handled: false, prevented: false };
        state.pending = true;
      },
      true,
    );
    // The router's capture listener is already installed on this same target. Its
    // stopPropagation does not skip later listeners in the same capture phase.
    field.addEventListener(
      "keydown",
      (event) => {
        if (!active || !event.isTrusted) return;
        active.handled = true;
        active.prevented = event.defaultPrevented;
        // A passthrough Space can first commit preedit; wait for its native input too.
        if (active.prevented) finish("handler-return");
      },
      true,
    );
  }, bench.sequence);
  let typed = 0;
  const applyKeys = async (count: number) => {
    for (let index = 0; index < count; index++, typed++) {
      const key = bench.sequence[typed % bench.sequence.length]!;
      await page.keyboard.press(key === " " ? "Space" : key);
      await page.waitForFunction(
        (expected) => window.ibusBench.samples.length === expected || !!window.ibusBench.error,
        index + 1,
      );
    }
  };
  // Warmup obeys the same applied-state sequencing as measurement. A flood of
  // unacknowledged keys can overrun an abandoned synchronous request's replay queue.
  await applyKeys(bench.warmup);
  await expect(page.locator("#input")).toHaveValue(bench.value(typed));
  await page.evaluate(() => {
    window.ibusBench.samples.length = 0;
  });
  await applyKeys(500);
  await expect(page.locator("#input")).toHaveValue(bench.value(typed));
  await bench.after(page);
  const result = await page.evaluate(() => window.ibusBench);
  expect(result.error).toBeUndefined();
  expect(result.pending).toBe(false);
  expect(result.samples).toHaveLength(500);
  expect(result.samples.every((sample) => Number.isFinite(sample.milliseconds) && sample.milliseconds >= 0)).toBe(true);
  const sorted = result.samples.map((sample) => sample.milliseconds).sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      metric:
        "trusted keydown capture to observed value/selection/preedit application; paint excluded; later-observer samples include observer delivery overhead",
      engine: bench.engine,
      browser: browserName,
      version: browser.version(),
      node: process.version,
      machine: {
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryBytes: totalmem(),
      },
      count: sorted.length,
      p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
      maxMs: sorted.at(-1),
      laterObserverSamples: result.samples.filter((sample) => sample.observation === "later-observer").length,
      nativeInputSamples: result.samples.filter((sample) => sample.observation === "native-input").length,
      samples: result.samples,
    }),
  );
};

test("500 trusted keydowns to observed application, Hangul", async ({ page, browser, browserName }) => {
  test.setTimeout(180_000);
  await measure(page, browser, browserName, {
    engine: "hangul",
    ready: hangul,
    sequence: "gksrmf ",
    warmup: 70,
    // Each round commits 한글 and a space; a round under way leaves its syllables in the preedit.
    value: (keys) => "한글 ".repeat(Math.floor(keys / 7)),
    after: (page) => expect(page.locator("[data-ibus-preedit]").filter({ hasText: "한" })).toBeVisible(),
  });
});

test("500 trusted keydowns to observed application, rime_ice", async ({ page, browser, browserName }) => {
  test.setTimeout(300_000);
  await measure(page, browser, browserName, {
    engine: "rime:rime_ice",
    ready: (page) => rime(page, "rime:rime_ice"),
    sequence: "nihao ",
    warmup: 72,
    // The Space commits each round's first candidate, 你好.
    value: (keys) => "你好".repeat(Math.floor(keys / 6)),
    // 500 keys end two into a round, its ni still composing.
    after: (page) => expect(candidates(page).first()).toBeVisible(),
  });
});
