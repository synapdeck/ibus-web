// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  CandidateClicked,
  CreateEngine,
  FocusIn,
  FocusOut,
  PageDown,
  Reset,
  type DecodedRecord,
  type OutputRecord,
} from "@ibus-web/protocol";
import { afterAll, afterEach, describe, expect, inject, test } from "vitest";
import { nodeHarness } from "../node/harness.ts";
import { Key, PageSession, type SessionOptions } from "./page-session.ts";

const h = await nodeHarness();
const build = inject("module");
const manifest = build.manifests["table"]!;
afterAll(() => h.cleanUp());

const latex: SessionOptions = { settings: [], engine: "latex" };
const xsampa: SessionOptions = { settings: [], engine: "xsampa" };

const tags = (records: DecodedRecord[]) => records.map(({ record }) => record._tag);
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

// Types ASCII, whose keysyms are its code points, expecting every key to be
// consumed.
const typeText = async (session: PageSession, ic: number, text: string): Promise<DecodedRecord[]> => {
  const records: DecodedRecord[] = [];
  for (const character of text) records.push(...(await session.key(ic, character.codePointAt(0)!, 0)));
  return records;
};

describe.each(h.data.runtimes)("the table module through $name host", (runtime) => {
  let current: PageSession | undefined;
  let heapPeak = 0;
  const start = async (options: SessionOptions, dist = manifest): Promise<PageSession> => {
    current = await PageSession.start(h, runtime, dist, options);
    return current;
  };
  afterEach(async () => {
    const running = current;
    current = undefined;
    if (running === undefined) return;
    try {
      const stats = await running.stats();
      heapPeak = Math.max(heapPeak, stats.heapPeak);
      expect(stats.activeThreadsAtRuntimeStart).toBe(0);
      expect(stats.activeThreadsPeak).toBeLessThanOrEqual(manifest.threads);
      expect(stats.heapPeak).toBeGreaterThan(0);
      expect(stats.heapPeak).toBeLessThanOrEqual(build.heapBytes);
      expect(stats.poolWorkersPeak).toBeLessThanOrEqual(build.poolBase + manifest.threads);
    } finally {
      await running.host.terminate();
    }
  });
  afterAll(() => h.record(`Table ${runtime.name} suite peaks`, { heapPeak, heapBytes: build.heapBytes }));

  test("LaTeX shows \\alpha underlined with its candidates and commits α on Space", async () => {
    const session = await start(latex);
    const records = await typeText(session, 1, "\\alpha");
    expect(last(records, "UpdatePreeditText")).toMatchObject({
      text: { text: "\\alpha", attrs: { attributes: [{ type: 1, value: 1, startIndex: 0, endIndex: 6 }] } },
      cursor: 6,
      visible: true,
      mode: 1,
    });
    const { table, visible } = last(records, "UpdateLookupTable");
    expect(visible).toBe(true);
    expect(table.pageSize).toBe(10);
    expect(table.cursorVisible).toBe(true);
    expect(table.candidates[table.cursorPos]?.text).toBe("α \\alpha");
    expect(committed(await session.key(1, ...Key.space))).toBe("α");
  });

  test("LaTeX commits → before a comma, which passes through", async () => {
    const session = await start(latex);
    await typeText(session, 1, "\\to");
    expect(committed(await session.key(1, ",".codePointAt(0)!, 0, 0))).toBe("→");
  });

  test("X-SAMPA beside LaTeX in one Worker turns S@ into ʃə and passes Space through", async () => {
    const session = await start(latex);
    await session.create(2, "xsampa");
    const records = [...(await typeText(session, 2, "S@")), ...(await session.key(2, ...Key.space, 0))];
    expect(committed(records)).toBe("ʃə");
    expect(records.filter(({ record }) => record._tag === "CommitText").every(({ ic }) => ic === 2)).toBe(true);
    await typeText(session, 1, "\\alpha");
    expect(committed(await session.key(1, ...Key.space))).toBe("α");
  });

  test("X-SAMPA's Escape commits the pending buffer raw and is consumed, and passes through when nothing is pending", async () => {
    const session = await start(xsampa);
    const typed = await typeText(session, 1, "S@");
    expect(committed(typed)).toBe("ʃ");
    expect(last(typed, "UpdatePreeditText").text.text).toBe("@");

    const escaped = await session.key(1, ...Key.escape);
    expect(committed(escaped)).toBe("@");
    expect(last(escaped, "UpdatePreeditText").visible).toBe(false);

    expect(tags(await session.key(1, ...Key.escape, 0))).toEqual([]);
  });

  test("only the cursor's page reaches IBus, and a click on the second page commits that page's candidate", async () => {
    const session = await start(latex);
    const opened = last(await typeText(session, 1, "\\"), "UpdateLookupTable").table;
    expect(opened.candidates).toHaveLength(10);
    expect(opened.cursorVisible).toBe(false);

    const first = last(await typeText(session, 1, "a"), "UpdateLookupTable").table;
    const second = last(await session.request(1, new PageDown({})), "UpdateLookupTable").table;
    expect(second.candidates.length).toBeLessThanOrEqual(10);
    expect(second.cursorPos).toBeLessThan(second.candidates.length);
    expect(second.candidates.map(({ text }) => text)).not.toEqual(first.candidates.map(({ text }) => text));

    const text = second.candidates[1]!.text;
    const clicked = await session.request(1, new CandidateClicked({ index: 1, button: 1, state: 0 }));
    expect(committed(clicked)).toBe(text.slice(0, text.lastIndexOf(" ")));
  });

  test("FocusOut and Reset end a composition without output", async () => {
    const session = await start(latex);
    for (const end of [new FocusOut({}), new Reset({})]) {
      await typeText(session, 1, "\\al");
      expect(tags(await session.request(1, end))).toEqual([]);
      await session.request(1, new FocusIn({}));
      expect(tags(await session.key(1, "x".codePointAt(0)!, 0, 0))).toEqual([]);
    }
  });

  test("LaTeX's table loads once per Worker", async () => {
    const session = await start(xsampa);
    const create = async (ic: number): Promise<number> => {
      const begin = performance.now();
      await session.request(ic, new CreateEngine({ name: "latex" }));
      return performance.now() - begin;
    };
    const firstMs = await create(2);
    const cachedMs = await create(3);
    h.record(`Table ${runtime.name} LaTeX load`, { firstMs, cachedMs });
    expect(cachedMs).toBeLessThan(firstMs);
  });

  test("a table that doesn't parse fails CreateEngine with the parser's message", async () => {
    const session = await start(xsampa, build.manifests["broken"]!);
    const records = await session.request(2, new CreateEngine({ name: "latex" }), -h.data.errno["EIO"]!);
    expect(records.map(({ ic, record }) => ({ ic, record }))).toEqual([
      { ic: 2, record: expect.objectContaining({ _tag: "CreateEngineFailed", message: build.texts["brokenMessage"] }) },
    ]);
    const typed = [...(await typeText(session, 1, "S@")), ...(await session.key(1, ...Key.space, 0))];
    expect(committed(typed)).toBe("ʃə");
  });
});
