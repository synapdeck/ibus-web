// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  CandidateClicked,
  DestroyEngine,
  FocusIn,
  FocusOut,
  IBusCapability,
  Reset,
  SetCapabilities,
  SetSurroundingText,
  SettingChanged,
  stringVariant,
  type DecodedRecord,
  type OutputRecord,
} from "@ibus-web/protocol";
import { afterAll, afterEach, beforeEach, describe, expect, inject, test } from "vitest";
import { nodeHarness } from "../node/harness.ts";
import { CAPABILITIES, Key, PageSession, type SessionOptions } from "./page-session.ts";

const HANGUL_SCHEMA = "org.freedesktop.ibus.engine.hangul";
const HANGUL_PATH = "/org/freedesktop/ibus/engine/hangul/";

const h = await nodeHarness();
const build = inject("module");
const manifest = build.manifests["hangul"]!;
const options: SessionOptions = {
  settings: [
    { schemaId: HANGUL_SCHEMA, path: HANGUL_PATH, values: { "hanja-keys": stringVariant("Hangul_Hanja,F9,F8") } },
  ],
  engine: "hangul",
  ready: (session, ic) => session.key(ic, ...Key.hangul),
};
afterAll(() => h.cleanUp());
const last = <Tag extends OutputRecord["_tag"]>(
  records: DecodedRecord[],
  tag: Tag,
): Extract<OutputRecord, { _tag: Tag }> => {
  const record = records.filter(({ record }) => record._tag === tag).at(-1)?.record;
  expect(record, tag).toBeDefined();
  return record as Extract<OutputRecord, { _tag: Tag }>;
};
const preedit = (records: DecodedRecord[], text: string): void => {
  expect(last(records, "UpdatePreeditText")).toMatchObject({
    text: { text },
    cursor: [...text].length,
    visible: true,
    mode: 1,
  });
};
const commit = (records: DecodedRecord[], text: string, ic = 1): void => {
  expect(last(records, "CommitText").text.text).toBe(text);
  expect(records.filter(({ record }) => record._tag === "CommitText").every((record) => record.ic === ic)).toBe(true);
};
const lookup = (records: DecodedRecord[]) => {
  const update = last(records, "UpdateLookupTable");
  expect(update.visible).toBe(true);
  expect(update.table.pageSize).toBe(9);
  expect(update.table.candidates.length).toBeGreaterThan(0);
  return update.table;
};

describe.each(h.data.runtimes)("Hangul through $name host", (runtime) => {
  let session: PageSession;
  let started = false;
  let heapPeak = 0;
  let poolWorkersPeak = 0;
  let activeThreadsPeak = 0;
  beforeEach(async () => {
    started = false;
    session = await PageSession.start(h, runtime, manifest, options);
    started = true;
  });
  afterEach(async () => {
    if (!started) return;
    try {
      const stats = await session.stats();
      heapPeak = Math.max(heapPeak, stats.heapPeak);
      poolWorkersPeak = Math.max(poolWorkersPeak, stats.poolWorkersPeak);
      activeThreadsPeak = Math.max(activeThreadsPeak, stats.activeThreadsPeak);
      expect(stats.activeThreadsAtRuntimeStart).toBe(0);
      expect(stats.activeThreadsPeak).toBeLessThanOrEqual(manifest.threads);
      expect(stats.heapPeak).toBeGreaterThan(0);
      expect(stats.heapPeak).toBeLessThanOrEqual(build.heapBytes);
      expect(stats.poolWorkersPeak).toBeLessThanOrEqual(build.poolBase + manifest.threads);
    } finally {
      await session.host.terminate();
    }
  });
  afterAll(() =>
    h.record(`Hangul ${runtime.name} suite peaks`, {
      heapPeak,
      poolWorkersPeak,
      activeThreadsPeak,
      threads: manifest.threads,
    }),
  );
  const compose = async (ic = 1, keyboard = "2") => {
    let updates: DecodedRecord[] = [];
    for (const [key, code, text] of keyboard === "2"
      ? ([
          ["g", 34, "ㅎ"],
          ["k", 37, "하"],
          ["s", 31, "한"],
        ] as const)
      : ([
          ["m", 50, "ㅎ"],
          ["f", 33, "하"],
          ["s", 31, "한"],
        ] as const)) {
      const records = await session.key(ic, key.charCodeAt(0), code);
      updates = records;
      preedit(records, text);
      expect(
        records.filter(({ record }) => record._tag === "UpdatePreeditText").every((record) => record.ic === ic),
      ).toBe(true);
    }
    return updates;
  };

  test("composition commits 한 on space", async () => {
    await compose();
    commit(await session.key(1, ...Key.space, 0), "한");
  });
  test("Hanja uses page-relative candidate clicks after PageDown", async () => {
    await compose();
    const table = lookup(await session.key(1, ...Key.f9));
    expect(table.candidates.length).toBeGreaterThan(10);
    const expected = table.candidates[10]!.text;
    const next = lookup(await session.key(1, ...Key.pageDown));
    expect(next.cursorPos).toBe(9);
    commit(await session.request(1, new CandidateClicked({ index: 1, button: 1, state: 0 })), expected);
  });
  test("Init snapshot enables F8 and setting changes select the 3-set keyboard", async () => {
    await compose();
    lookup(await session.key(1, ...Key.f8));
    await session.request(1, new Reset({}));
    const changed = await session.request(
      0,
      new SettingChanged({ path: HANGUL_PATH, key: "hangul-keyboard", value: stringVariant("39") }),
    );
    expect(changed.some(({ record }) => record._tag === "SettingWritten")).toBe(false);
    await compose(1, "39");
  });
  test("an instrumented engine-schema write emits SettingWritten on context zero", async () => {
    const records = await session.writeStringSetting(
      h.data.constants.ops["SETTING_WRITE"]!,
      HANGUL_SCHEMA,
      "hangul-keyboard",
      "39",
    );
    const written = records.find(({ record }) => record._tag === "SettingWritten");
    expect(written).toMatchObject({
      ic: 0,
      record: { _tag: "SettingWritten", path: HANGUL_PATH, key: "hangul-keyboard", value: stringVariant("39") },
    });
    await compose(1, "39");
  });
  test("destroy and recreate reuse an input context without its old preedit", async () => {
    await compose();
    await session.request(1, new DestroyEngine({}));
    await session.create(1);
    await compose();
    commit(await session.key(1, ...Key.space, 0), "한");
  });
  test("two contexts compose independently", async () => {
    await session.create(2);
    preedit(await session.key(1, 103, 34), "ㅎ");
    await compose(2);
    preedit(await session.key(1, 107, 37), "하");
    commit(await session.key(2, ...Key.space, 0), "한", 2);
    commit(await session.key(1, ...Key.space, 0), "하");
  });
  test("surrounding Hanja deletes the preceding syllable before committing 韓", async () => {
    await session.request(
      1,
      new SetSurroundingText({
        text: { attachments: {}, text: "한", attrs: { attachments: {}, attributes: [] } },
        cursor: 1,
        anchor: 1,
      }),
    );
    const table = lookup(await session.key(1, ...Key.f9));
    const index = table.candidates.findIndex((candidate) => candidate.text === "韓");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(9);
    const records = await session.request(1, new CandidateClicked({ index, button: 1, state: 0 }));
    expect(last(records, "DeleteSurroundingText")).toMatchObject({ offset: -1, count: 1 });
    commit(records, "韓");
    expect(records.findIndex(({ record }) => record._tag === "DeleteSurroundingText")).toBeLessThan(
      records.findIndex(({ record }) => record._tag === "CommitText"),
    );
  });
  test("synchronous forwarding replies handled and commits before forwarding space", async () => {
    await session.request(1, new SetCapabilities({ capabilities: CAPABILITIES | IBusCapability.SYNC_PROCESS_KEY }));
    await compose();
    const records = await session.key(1, ...Key.space);
    commit(records, "한");
    expect(
      records.filter(({ record }) => record._tag === "ForwardKeyEvent").map(({ record }) => record),
    ).toContainEqual(expect.objectContaining({ keyval: 32, keycode: 57, state: 0 }));
    expect(records.findIndex(({ record }) => record._tag === "CommitText")).toBeLessThan(
      records.findIndex(({ record }) => record._tag === "ForwardKeyEvent"),
    );
  });
  // A COMMIT-mode preedit is the client's to commit on focus out, so the
  // engine only hides it; one in CLEAR mode, under the Hanja table, is
  // dropped with the table, and neither commits.
  const tags = (records: DecodedRecord[]) => records.map(({ record }) => record._tag);
  test("focus out leaves client-owned COMMIT-mode preedit without committing", async () => {
    expect(last(await compose(), "UpdatePreeditText").mode).toBe(1);
    expect(tags(await session.request(1, new FocusOut({})))).toEqual(["HidePreeditText"]);
    await session.request(1, new FocusIn({}));
    await compose();
    expect(last(await session.key(1, ...Key.f9), "UpdatePreeditText")).toMatchObject({ text: { text: "한" }, mode: 0 });
    expect(tags(await session.request(1, new FocusOut({})))).toEqual([
      "HideLookupTable",
      "HideAuxiliaryText",
      "HidePreeditText",
    ]);
  });
  test("Hanja and repeated lifecycle stay within the declared heap and threads", async () => {
    const before = await session.stats();
    for (let i = 0; i < 3; i++) {
      await compose();
      lookup(await session.key(1, ...Key.f9));
      await session.request(1, new DestroyEngine({}));
      await session.create(1);
    }
    const stats = await session.stats();
    h.record(`Hangul ${runtime.name} resources`, {
      heapPeak: stats.heapPeak,
      poolWorkersPeak: stats.poolWorkersPeak,
      idleWorkers: stats.idleWorkers,
      activeThreadsPeak: stats.activeThreadsPeak,
      threads: manifest.threads,
      heapBytes: build.heapBytes,
    });
    expect(stats.poolWorkersPeak).toBe(build.poolBase + manifest.threads);
    expect(stats.workersCreated).toBe(0);
    expect(stats).toMatchObject({ activeThreadsAtRuntimeStart: 0, activeThreadsPeak: 0 });
    expect(stats.heapPeak).toBeGreaterThan(0);
    expect(stats.heapPeak).toBeGreaterThanOrEqual(before.heapPeak);
    expect(stats.heapPeak).toBeLessThanOrEqual(build.heapBytes);
  });
});
