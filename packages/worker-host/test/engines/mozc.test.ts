// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { DecodedRecord, OutputRecord } from "@ibus-web/protocol";
import { afterAll, afterEach, describe, expect, inject, test } from "vitest";
import { nodeHarness } from "../node/harness.ts";
import { Key, PageSession, type SessionOptions } from "./page-session.ts";

const h = await nodeHarness();
const build = inject("module");
const manifest = build.manifests["mozc"]!;
afterAll(() => h.cleanUp());

const hiragana: SessionOptions = { settings: {}, engine: "mozc-on" };
const direct: SessionOptions = { settings: {}, engine: "mozc-off" };
const enter = [0xff0d, 28] as const;

const last = <Tag extends OutputRecord["_tag"]>(
  records: DecodedRecord[],
  tag: Tag,
): Extract<OutputRecord, { _tag: Tag }> => {
  const record = records.filter(({ record }) => record._tag === tag).at(-1)?.record;
  expect(record, tag).toBeDefined();
  return record as Extract<OutputRecord, { _tag: Tag }>;
};
const committed = (records: DecodedRecord[]): string =>
  records.map(({ record }) => (record._tag === "CommitText" ? record.text.text : "")).join("");

// Types ASCII, whose keysyms are its code points.
const typeText = async (session: PageSession, ic: number, text: string, ret = 1): Promise<DecodedRecord[]> => {
  const records: DecodedRecord[] = [];
  for (const character of text) records.push(...(await session.key(ic, character.codePointAt(0)!, 0, ret)));
  return records;
};

describe.each(h.data.runtimes)("Mozc through $name host", (runtime) => {
  let current: PageSession | undefined;
  let breakPeak = 0;
  let threadsPeak = 0;
  const start = async (options: SessionOptions): Promise<PageSession> => {
    const begin = performance.now();
    current = await PageSession.start(h, runtime, manifest, options);
    h.record(`Mozc ${runtime.name} start`, { ms: performance.now() - begin });
    return current;
  };
  afterEach(async () => {
    const running = current;
    current = undefined;
    if (running === undefined) return;
    try {
      const stats = await running.stats();
      breakPeak = Math.max(breakPeak, stats.breakPeak);
      threadsPeak = Math.max(threadsPeak, stats.activeThreadsPeak);
      expect(stats.activeThreadsPeak).toBeLessThanOrEqual(manifest.threads);
      expect(stats.breakPeak).toBeGreaterThan(0);
      expect(stats.breakPeak).toBeLessThanOrEqual(build.heapBytes);
      expect(stats.poolWorkersPeak).toBeLessThanOrEqual(build.poolBase + manifest.threads);
    } finally {
      await running.host.terminate();
    }
  });
  afterAll(() => h.record(`Mozc ${runtime.name} suite peaks`, { breakPeak, threadsPeak, heapBytes: build.heapBytes }));

  test("romaji composes underlined hiragana, Space converts it and Enter commits the conversion", async () => {
    const session = await start(hiragana);
    const composed = last(await typeText(session, 1, "kyouhaiitenkidesu"), "UpdatePreeditText");
    expect(composed.text.text).toBe("きょうはいいてんきです");
    expect(composed.visible).toBe(true);

    const converted = last(await session.key(1, ...Key.space), "UpdatePreeditText");
    expect(converted.text.text).toBe("今日はいい天気です");

    expect(committed(await session.key(1, ...enter))).toBe("今日はいい天気です");
  });

  test("a second Space opens IBus's candidate window on the first segment", async () => {
    const session = await start(hiragana);
    await typeText(session, 1, "kanji");
    await session.key(1, ...Key.space);
    const { table, visible } = last(await session.key(1, ...Key.space), "UpdateLookupTable");
    expect(visible).toBe(true);
    expect(table.candidates.length).toBeGreaterThan(1);
    expect(table.candidates.map(({ text }) => text)).toContain("漢字");
  });

  test("the direct-input engine passes keys through", async () => {
    const session = await start(direct);
    expect(committed(await typeText(session, 1, "abc", 0))).toBe("");
  });
});
