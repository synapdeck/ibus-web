// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { chmod, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  Persist,
  SettingChanged,
  int32Variant,
  type DecodedRecord,
  type Init,
  type OutputRecord,
} from "@ibus-web/protocol";
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

// The user directory of a session's storage, which a Node host mounts from
// the host's file system.
const userDirectory = (session: PageSession): string => {
  const storage = h.storage(session.manifest);
  if (storage.kind !== "node") throw new Error(`storage ${storage.kind}`);
  return join(storage.hostPath, "user");
};

// Every file and directory under dir, with what a write would change.
const listing = async (dir: string): Promise<Record<string, { size: number; mtimeMs: number }>> => {
  const entries = await readdir(dir, { recursive: true });
  return Object.fromEntries(
    await Promise.all(
      entries.toSorted().map(async (name) => {
        const { size, mtimeMs, isDirectory } = await stat(join(dir, name)).then((stats) => ({
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          isDirectory: stats.isDirectory(),
        }));
        return [name, { size: isDirectory ? 0 : size, mtimeMs }] as const;
      }),
    ),
  );
};

// Node's backend has no read-only mount, so the host file system refuses the
// writes a browser's read-only mount would.
const writable = async (dir: string, allowed: boolean): Promise<void> => {
  const mode = (directory: boolean) => (allowed ? (directory ? 0o755 : 0o644) : directory ? 0o555 : 0o444);
  if (allowed) await chmod(dir, mode(true));
  for (const name of await readdir(dir, { recursive: true })) {
    const path = join(dir, name);
    await chmod(path, mode((await stat(path)).isDirectory()));
  }
  if (!allowed) await chmod(dir, mode(true));
};

// Types ASCII, whose keysyms are its code points; ibus-rime reads the keysym.
const typeText = async (session: PageSession, ic: number, text: string): Promise<DecodedRecord[]> => {
  const records: DecodedRecord[] = [];
  for (const character of text) records.push(...(await session.key(ic, character.codePointAt(0)!, 0)));
  return records;
};

describe.each(h.data.runtimes)("Rime through $name host", (runtime) => {
  let current: PageSession | undefined;
  let heapPeak = 0;
  let threadsPeak = 0;
  const start = async (engine: string): Promise<PageSession> => {
    const begin = performance.now();
    current = await PageSession.start(h, runtime, manifest, options(engine));
    const ms = performance.now() - begin;
    const { warms, lastWarmed, firstWarmMs, lastWarmMs } = await current.stats();
    h.record(`Rime ${runtime.name} start`, { ms, warms, lastWarmed, firstWarmMs, lastWarmMs });
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
  afterAll(() => h.record(`Rime ${runtime.name} suite peaks`, { heapPeak, threadsPeak, heapBytes: build.heapBytes }));

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

  // Before the module knew its user data was read-only, opening LevelDB failed
  // at its lock file, Rime scheduled a recovery that failed too and ended
  // every session, and each new session did it again.
  test("a second host on the same storage is read-only: it types from the shipped dictionaries, opens no user dictionary and ends no session", async () => {
    const writer = await start(RIME_ICE);
    await deployed(writer, 1);
    await typeText(writer, 1, "nihao");
    expect(committed(await writer.key(1, ...Key.space))).toBe("你好");
    await writer.request(0, new Persist({}));

    const user = userDirectory(writer);
    const before = await listing(user);
    expect(Object.keys(before)).toContain("rime_ice.userdb");
    await writable(user, false);
    let reader: PageSession | undefined;
    try {
      reader = await PageSession.start(h, runtime, manifest, { ...options(RIME_ICE), sharing: writer });
      expect(reader.host.messages).toContainEqual(expect.objectContaining({ type: "storage", state: "read-only" }));
      await deployed(reader, 1);

      await typeText(reader, 1, "ni");
      await reader.create(2);
      await typeText(reader, 1, "hao");
      expect(committed(await reader.key(1, ...Key.space))).toBe("你好");
      await typeText(reader, 2, "zhongguo");
      expect(committed(await reader.key(2, ...Key.space))).toBe("中国");

      expect(reader.logs.filter((message) => message.startsWith("Rime is under maintenance"))).toEqual([]);
      expect(reader.logs.filter((message) => message.startsWith("Rime has encountered an error"))).toEqual([]);
      expect(await listing(user)).toEqual(before);
    } finally {
      await reader?.host.terminate();
      await writable(user, true);
    }
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
