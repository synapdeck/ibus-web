// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  CandidateClicked,
  CursorDown,
  PageDown,
  PageUp,
  SettingChanged,
  booleanVariant,
  stringVariant,
  type DecodedRecord,
  type OutputRecord,
} from "@ibus-web/protocol";
import { afterAll, afterEach, describe, expect, inject, test } from "vitest";
import { nodeHarness } from "../node/harness.ts";
import { Key, PageSession, type SessionOptions } from "./page-session.ts";

const h = await nodeHarness();
const build = inject("module");
const manifest = build.manifests["mozc"]!;
afterAll(() => h.cleanUp());

const MOZC_SCHEMA = "org.freedesktop.ibus.engine.mozc";
const MOZC_PATH = "/org/freedesktop/ibus/engine/mozc/";
const hiragana: SessionOptions = { settings: [], engine: "mozc-on" };
const direct: SessionOptions = { settings: [], engine: "mozc-off" };
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
  let heapPeak = 0;
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
      heapPeak = Math.max(heapPeak, stats.heapPeak);
      threadsPeak = Math.max(threadsPeak, stats.activeThreadsPeak);
      expect(stats.activeThreadsPeak).toBeLessThanOrEqual(manifest.threads);
      expect(stats.heapPeak).toBeGreaterThan(0);
      expect(stats.heapPeak).toBeLessThanOrEqual(build.heapBytes);
      expect(stats.poolWorkersPeak).toBeLessThanOrEqual(build.poolBase + manifest.threads);
    } finally {
      await running.host.terminate();
    }
  });
  afterAll(() => h.record(`Mozc ${runtime.name} suite peaks`, { heapPeak, threadsPeak, heapBytes: build.heapBytes }));

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

  const texts = (table: { readonly candidates: readonly { readonly text: string }[] }) =>
    table.candidates.map(({ text }) => text);

  test("the panel's page and cursor controls page and move through Mozc's candidates", async () => {
    const session = await start(hiragana);
    await typeText(session, 1, "kanji");
    await session.key(1, ...Key.space);
    const first = last(await session.key(1, ...Key.space), "UpdateLookupTable").table;

    const moved = last(await session.request(1, new CursorDown({})), "UpdateLookupTable").table;
    expect(moved.cursorPos).toBe(first.cursorPos + 1);

    const second = last(await session.request(1, new PageDown({})), "UpdateLookupTable").table;
    expect(texts(second)).not.toEqual(texts(first));
    const back = last(await session.request(1, new PageUp({})), "UpdateLookupTable").table;
    expect(texts(back)).toEqual(texts(first));
  });

  // Mozc sends one page of candidates at a time, so the panel's page-relative
  // index is the index into what Mozc last sent.
  test("a click on the second page commits that page's candidate", async () => {
    const session = await start(hiragana);
    await typeText(session, 1, "kanji");
    await session.key(1, ...Key.space);
    const first = last(await session.key(1, ...Key.space), "UpdateLookupTable").table;
    const second = last(await session.request(1, new PageDown({})), "UpdateLookupTable").table;
    expect(texts(second)).not.toEqual(texts(first));

    const chosen = second.candidates[1]!.text;
    const clicked = await session.request(1, new CandidateClicked({ index: 1, button: 1, state: 0 }));
    expect(committed(clicked)).toBe(chosen);
    const shown = (show: string, hide: string, update: string) =>
      clicked.reduce<boolean | undefined>(
        (visible, { record }) =>
          record._tag === show
            ? true
            : record._tag === hide
              ? false
              : record._tag === update
                ? (record as { visible: boolean }).visible
                : visible,
        undefined,
      );
    expect(shown("ShowPreeditText", "HidePreeditText", "UpdatePreeditText")).toBe(false);
    expect(shown("ShowLookupTable", "HideLookupTable", "UpdateLookupTable")).toBe(false);
  });

  test("Init's punctuation setting reaches the converter", async () => {
    const session = await start({
      ...hiragana,
      settings: [
        { schemaId: MOZC_SCHEMA, path: MOZC_PATH, values: { "punctuation-method": stringVariant("comma-period") } },
      ],
    });
    await typeText(session, 1, "a,");
    expect(committed(await session.key(1, ...enter))).toBe("あ，");
  });

  test("a punctuation change applies to the context already open", async () => {
    const session = await start({ ...hiragana, settings: [{ schemaId: MOZC_SCHEMA, path: MOZC_PATH, values: {} }] });
    await typeText(session, 1, "a,");
    expect(committed(await session.key(1, ...enter))).toBe("あ、");

    const changed = await session.request(
      0,
      new SettingChanged({ path: MOZC_PATH, key: "punctuation-method", value: stringVariant("comma-period") }),
    );
    expect(changed.some(({ record }) => record._tag === "SettingWritten")).toBe(false);
    await typeText(session, 1, "a,");
    expect(committed(await session.key(1, ...enter))).toBe("あ，");
  });

  test("active-on-launch starts mozc-jp in hiragana, which otherwise starts in direct input", async () => {
    const off = await start({ settings: [], engine: "mozc-jp" });
    expect(committed(await typeText(off, 1, "a", 0))).toBe("");
    await off.host.terminate();
    current = undefined;

    const on = await start({
      settings: [{ schemaId: MOZC_SCHEMA, path: MOZC_PATH, values: { "active-on-launch": booleanVariant(true) } }],
      engine: "mozc-jp",
    });
    await typeText(on, 1, "a");
    expect(committed(await on.key(1, ...enter))).toBe("あ");
  });

  test("the direct-input engine passes keys through", async () => {
    const session = await start(direct);
    expect(committed(await typeText(session, 1, "abc", 0))).toBe("");
  });
});
