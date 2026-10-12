// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { SettingChanged, int32Variant, type DecodedRecord, type Init, type OutputRecord } from "@ibus-web/protocol";
import { afterAll, afterEach, describe, expect, inject, test } from "vitest";
import type { PathInstallReport } from "../../src/shared/messages.ts";
import { nodeHarness } from "../node/harness.ts";
import { installOf } from "../shared/install.ts";
import type { Message } from "../shared/testing.ts";
import { Key, PageSession, type SessionOptions } from "./page-session.ts";

const h = await nodeHarness();
const build = inject("module");
const manifest = build.manifests["rime"]!;
afterAll(() => h.cleanUp());

type Values = Init["settings"][number]["values"];

const RIME_PATH = "/org/freedesktop/ibus/engine/rime/";
const RIME_ICE = "rime:rime_ice";
const READY = "Rime is ready.";

const metadata = JSON.parse(build.texts["settings"]!) as { schemas: { id: string; paths: string[] }[] };

// Every instance the metadata declares, as the page sends them: the given
// values at their paths and nothing stored anywhere else.
const instances = (values: Readonly<Record<string, Values>> = {}): Init["settings"] =>
  metadata.schemas.flatMap(({ id, paths }) =>
    paths.map((path) => ({ schemaId: id, path, values: values[path] ?? {} })),
  );
// Rime's first start in a new user directory warns of the files it lacks,
// and every deployment of rime-data's configs of their own includes.
const options = (engine: string): SessionOptions => ({
  settings: instances(),
  engine,
  deployment: { start: "Rime is under maintenance ...", end: READY },
});

// What rime-data's configs warn of whenever they are compiled; a deployment
// that warned of anything else, such as a dictionary not installed, fails.
const CONFIG_WARNING = [
  /^config_compiler\.cc:\d+: (circular dependencies detected|accessing blocking node with unresolved dependencies)\b/,
  /^config_data\.cc:\d+: nonexistent config file '\/engines\/[^']+\.yaml'\.$/,
];
const expected = (warning: string): boolean => CONFIG_WARNING.some((pattern) => pattern.test(warning));

const ownData = (engine: string): readonly string[] => manifest.engines.find(({ name }) => name === engine)?.data ?? [];
const lazy = new Set(manifest.engines.flatMap(({ data }) => data ?? []));
const sizeOf = (paths: Iterable<string>): number =>
  [...paths].reduce((sum, path) => sum + manifest.data.find(({ storePath }) => storePath === path)!.size, 0);

const pathInstalls = (messages: readonly Message[], engine: string): PathInstallReport[] =>
  messages.flatMap((message) => {
    if (message.type !== "path-install" || message.engine !== engine) return [];
    const { type: _, ...report } = message;
    return [report];
  });
const progressOf = (messages: readonly Message[], engine: string): { bytes: number; total: number }[] =>
  messages.flatMap((message) =>
    message.type === "prepare-progress" && message.engine === engine
      ? [{ bytes: message.bytes, total: message.total }]
      : [],
  );

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

// Waits until Rime has said it is ready this many times since the host
// started: once for its first start, then once for each deployment after.
const deployed = async (session: PageSession, times: number): Promise<void> => {
  const deadline = h.now() + 60_000;
  while (session.logs.filter((message) => message === READY).length < times) {
    expect(h.now(), `deployment ${times}`).toBeLessThan(deadline);
    await h.sleep(50);
    session.read();
  }
};

// Types ASCII, whose keysyms are its code points; ibus-rime reads the keysym.
const typeText = async (session: PageSession, ic: number, text: string): Promise<DecodedRecord[]> => {
  const records: DecodedRecord[] = [];
  for (const character of text) records.push(...(await session.key(ic, character.codePointAt(0)!, 0)));
  return records;
};

describe.each(h.data.runtimes)("Rime through $name host", (runtime) => {
  let current: PageSession | undefined;
  let breakPeak = 0;
  let threadsPeak = 0;
  const start = async (engine: string): Promise<PageSession> => {
    const begin = performance.now();
    current = await PageSession.start(h, runtime, manifest, options(engine));
    h.record(`Rime ${runtime.name} start`, { ms: performance.now() - begin });
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
  afterAll(() => h.record(`Rime ${runtime.name} suite peaks`, { breakPeak, threadsPeak, heapBytes: build.heapBytes }));

  test("the base data installs at start, rime:rime_ice's dictionaries when it is prepared, and nihao commits 你好", async () => {
    const session = await start(RIME_ICE);
    const { messages } = session.host;
    const base = manifest.data.filter(({ storePath }) => !lazy.has(storePath));
    expect(installOf(messages)?.bytes, "the base data installed at start").toBe(sizeOf(base.map((e) => e.storePath)));
    const own = ownData(RIME_ICE);
    const reports = pathInstalls(messages, RIME_ICE);
    expect(reports.map(({ storePath }) => storePath).toSorted(), "rime_ice's dictionaries").toEqual(
      [...own].toSorted(),
    );
    expect(new Set(reports.map(({ state }) => state)), "installed, all of them").toEqual(new Set(["installed"]));
    const progress = progressOf(messages, RIME_ICE);
    expect(progress.at(-1), "the last progress").toEqual({ bytes: sizeOf(own), total: sizeOf(own) });
    h.record(`Rime ${runtime.name} rime_ice install`, {
      bytes: sizeOf(own),
      ms: reports.reduce((sum, { installMs }) => sum + installMs, 0),
    });

    // ibus-rime declines keys until Rime's first start has ended.
    await deployed(session, 1);
    await typeText(session, 1, "nihao");
    expect(committed(await session.key(1, ...Key.space))).toBe("你好");
  });

  test("in one Worker, rime:double_pinyin finds rime_ice's dictionaries present and rime:luna_pinyin converts beside it", async () => {
    const session = await start(RIME_ICE);
    const { messages } = session.host;
    await deployed(session, 1);
    await typeText(session, 1, "nihao");
    expect(committed(await session.key(1, ...Key.space))).toBe("你好");

    await session.create(2, "rime:double_pinyin");
    const shared = pathInstalls(messages, "rime:double_pinyin");
    expect(shared.length, "double pinyin's dictionaries").toBeGreaterThan(0);
    expect(new Set(shared.map(({ state }) => state)), "present, all of them").toEqual(new Set(["present"]));
    expect(progressOf(messages, "rime:double_pinyin"), "progress for data already there").toEqual([]);

    await session.create(3, "rime:luna_pinyin");
    expect(
      pathInstalls(messages, "rime:luna_pinyin").some(({ state }) => state === "installed"),
      "luna_pinyin's own dictionaries installed",
    ).toBe(true);
    await typeText(session, 3, "zhongguo");
    expect(committed(await session.key(3, ...Key.space))).toBe("中國");
  });

  test("a settings change with only rime_ice's dictionaries installed redeploys without warning of a dictionary and reaches the context", async () => {
    const session = await start(RIME_ICE);
    await deployed(session, 1);
    const before = session.deploymentWarnings.length;
    await session.request(0, new SettingChanged({ path: RIME_PATH, key: "page-size", value: int32Variant(7) }));

    // ibus-rime declines keys while the deployer works, and ends every
    // session once it has returned, so the context's next key opens one
    // with the change.
    await deployed(session, 2);
    expect(session.deploymentWarnings.slice(before).filter((warning) => !expected(warning))).toEqual([]);
    expect(last(await typeText(session, 1, "ni"), "UpdateLookupTable").table.pageSize).toBe(7);
  });
});
