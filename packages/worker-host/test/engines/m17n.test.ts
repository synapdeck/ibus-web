// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  CreateEngine,
  FocusIn,
  FocusOut,
  IBusAttrType,
  Init,
  PROTOCOL_VERSION,
  SetSurroundingText,
  SettingChanged,
  encodeRequest,
  int32Variant,
  stringVariant,
  type DecodedRecord,
  type OutputRecord,
} from "@ibus-web/protocol";
import { afterAll, afterEach, describe, expect, inject, test } from "vitest";
import { nodeHarness } from "../node/harness.ts";
import { PageSession, type SessionOptions } from "./page-session.ts";

const h = await nodeHarness();
const build = inject("module");
const manifest = build.manifests["m17n"]!;
afterAll(() => h.cleanUp());

type Values = Init["settings"][number]["values"];

// ibus-m17n opens its relocatable schema at each engine's own path, and an
// input method's variables live below it.
const enginePath = (engine: string) => `/org/freedesktop/ibus/engine/${engine.split(":").join("/")}/`;
const variablesPath = (engine: string) => `${enginePath(engine)}variables/`;

const metadata = JSON.parse(build.texts["settings"]!) as {
  schemas: { id: string; paths: string[]; pattern?: string }[];
};
const declared = new Set(metadata.schemas.flatMap(({ paths }) => paths));
const patterns: Init["patterns"] = metadata.schemas.flatMap(({ id, pattern }) =>
  pattern === undefined ? [] : [{ schemaId: id, pattern }],
);

// The instances the page declares with the given values stored and nothing
// stored anywhere else: every instance of a schema without a pattern, and a
// patterned schema's only where values are stored.
const instances = (values: Readonly<Record<string, Values>> = {}): Init["settings"] => {
  for (const path of Object.keys(values)) expect(declared.has(path), path).toBe(true);
  return metadata.schemas.flatMap(({ id, paths, pattern }) =>
    paths.flatMap((path) =>
      pattern !== undefined && values[path] === undefined ? [] : [{ schemaId: id, path, values: values[path] ?? {} }],
    ),
  );
};
const options = (engine: string, values?: Readonly<Record<string, Values>>): SessionOptions => ({
  settings: instances(values),
  patterns,
  engine,
});

// Evdev codes of the keys typed here, whose keysyms are their code points.
const keycodes: Readonly<Record<string, number>> = {
  " ": 57,
  "'": 40,
  a: 30,
  e: 18,
  f: 33,
  h: 35,
  i: 23,
  j: 36,
  k: 37,
  o: 24,
  t: 20,
  v: 47,
};

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
const attribute = (records: DecodedRecord[], type: number): number | undefined =>
  last(records, "UpdatePreeditText").text.attrs.attributes.find((attribute) => attribute.type === type)?.value;

// What a field holds after typing: the engine's commits, and each key it
// declines inserted as the browser would.
const typeText = async (session: PageSession, ic: number, text: string) => {
  let field = "";
  const records: DecodedRecord[] = [];
  for (const character of text) {
    const key = await session.press(ic, character.codePointAt(0)!, keycodes[character]!);
    records.push(...key.records);
    field += committed(key.records);
    if (!key.handled) field += character;
  }
  return { field, records };
};

// Init travels in one request, and the transport's default slot is 64 KiB.
// The engines' own instances are declared by one pattern, so Init grows only
// with the values stored, even with one at every engine.
test("Init declares the engines' instances by pattern, and fits one request with a value stored at each", () => {
  const init = (settings: Init["settings"]) =>
    encodeRequest(0, new Init({ version: PROTOCOL_VERSION, userDataWritable: true, settings, patterns })).byteLength;

  expect(patterns).toEqual([
    { schemaId: "org.freedesktop.ibus.engine.m17n", pattern: "/org/freedesktop/ibus/engine/m17n/{lang}/{name}/" },
  ]);
  const engines = metadata.schemas.find(({ id }) => id === "org.freedesktop.ibus.engine.m17n")!.paths;
  const empty = instances();
  const stored = instances(
    Object.fromEntries(
      engines.map((path) => [
        path,
        { "preedit-foreground": stringVariant("#ff0000"), "preedit-underline": int32Variant(1) },
      ]),
    ),
  );
  h.record("m17n Init", {
    declared: declared.size,
    instances: empty.length,
    bytes: init(empty),
    storedInstances: stored.length,
    storedBytes: init(stored),
  });
  expect(empty.length).toBe(declared.size - engines.length);
  expect(init(stored)).toBeLessThan(64 * 1024);
});

describe.each(h.data.runtimes)("m17n through $name host", (runtime) => {
  let current: PageSession | undefined;
  let heapPeak = 0;
  const start = async (engine: string, values?: Readonly<Record<string, Values>>): Promise<PageSession> => {
    const begin = performance.now();
    current = await PageSession.start(h, runtime, manifest, options(engine, values));
    h.record(`m17n ${runtime.name} start`, { ms: performance.now() - begin });
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
      expect(stats.activeThreadsPeak).toBe(0);
      expect(stats.heapPeak).toBeGreaterThan(0);
      expect(stats.heapPeak).toBeLessThanOrEqual(build.heapBytes);
      expect(stats.poolWorkersPeak).toBeLessThanOrEqual(build.poolBase + manifest.threads);
    } finally {
      await running.host.terminate();
    }
  });
  afterAll(() => h.record(`m17n ${runtime.name} suite peaks`, { heapPeak, heapBytes: build.heapBytes }));

  test("t:latn-post composes á from a and ' and commits it with the Space", async () => {
    const session = await start("m17n:t:latn-post");
    expect(last((await typeText(session, 1, "a")).records, "UpdatePreeditText").text.text).toBe("a");
    expect(last((await typeText(session, 1, "'")).records, "UpdatePreeditText").text.text).toBe("á");
    expect((await typeText(session, 1, " ")).field).toBe("á ");
  });

  test("hi:inscript commits क for k", async () => {
    const session = await start("m17n:hi:inscript");
    expect((await typeText(session, 1, "k")).field).toBe("क");
  });

  test("vi:telex composes việt and commits it with the Space", async () => {
    const session = await start("m17n:vi:telex");
    expect((await typeText(session, 1, "vieetj ")).field).toBe("việt ");
  });

  test("vi:telex puts the tone of oa on the first vowel by default", async () => {
    const session = await start("m17n:vi:telex");
    expect((await typeText(session, 1, "hoaf ")).field).toBe("hòa ");
  });

  test("a variable's value from Init reaches the input method", async () => {
    const session = await start("m17n:vi:telex", {
      [variablesPath("m17n:vi:telex")]: { "tone-mark-on-last": int32Variant(1) },
    });
    expect((await typeText(session, 1, "hoaf ")).field).toBe("hoà ");
  });

  const toneOnLast = () =>
    new SettingChanged({ path: variablesPath("m17n:vi:telex"), key: "tone-mark-on-last", value: int32Variant(1) });

  test("a variable change reaches a context made afterwards", async () => {
    const session = await start("m17n:t:latn-post");
    await session.request(0, toneOnLast());
    await session.create(2, "m17n:vi:telex");
    expect((await typeText(session, 2, "hoaf ")).field).toBe("hoà ");
  });

  // ibus-m17n resets its m17n context on focus-out, and a reset takes the
  // input method's configured values again.
  test("a variable change reaches an existing context at its next focus-out", async () => {
    const session = await start("m17n:vi:telex");
    expect((await typeText(session, 1, "hoaf ")).field).toBe("hòa ");

    await session.request(0, toneOnLast());
    await session.request(1, new FocusOut({}));
    await session.request(1, new FocusIn({}));
    expect((await typeText(session, 1, "hoaf ")).field).toBe("hoà ");
  });

  test("th:kesmanee takes a tone mark only after the consonant before the caret", async () => {
    const session = await start("m17n:th:kesmanee");
    expect((await typeText(session, 1, "h")).field).toBe("");

    await session.request(
      1,
      new SetSurroundingText({
        text: { attachments: {}, text: "ก", attrs: { attachments: {}, attributes: [] } },
        cursor: 1,
        anchor: 1,
      }),
    );
    expect((await typeText(session, 1, "h")).field).toBe("้");
  });

  test("zh:cangjie lists 日 and 曰 for a and commits 日 with the Space", async () => {
    const session = await start("m17n:zh:cangjie");
    const shown = last((await typeText(session, 1, "a")).records, "UpdateLookupTable");
    expect(shown.visible).toBe(true);
    expect(shown.table.candidates.slice(0, 2).map(({ text }) => text)).toEqual(["日", "曰"]);
    expect((await typeText(session, 1, " ")).field).toBe("日");
  });

  test("Init's value at one engine's path reaches that engine and no other", async () => {
    const session = await start("m17n:t:latn-post", {
      [enginePath("m17n:t:latn-post")]: { "preedit-foreground": stringVariant("#ff0000") },
    });
    await session.create(2, "m17n:vi:telex");
    expect(attribute((await typeText(session, 1, "a")).records, IBusAttrType.Foreground)).toBe(0xff0000);
    expect(attribute((await typeText(session, 2, "vieetj")).records, IBusAttrType.Foreground)).toBeUndefined();
  });

  test("a change at one engine's path reaches that engine's context and no other's", async () => {
    const session = await start("m17n:t:latn-post");
    await session.create(2, "m17n:vi:telex");
    expect(attribute((await typeText(session, 1, "a")).records, IBusAttrType.Underline)).toBe(0);

    const changed = await session.request(
      0,
      new SettingChanged({ path: enginePath("m17n:t:latn-post"), key: "preedit-underline", value: int32Variant(1) }),
    );
    expect(changed.some(({ record }) => record._tag === "SettingWritten")).toBe(false);

    expect(attribute((await typeText(session, 1, "'")).records, IBusAttrType.Underline)).toBe(1);
    expect(attribute((await typeText(session, 2, "vieetj")).records, IBusAttrType.Underline)).toBe(0);
  });

  test("what an engine emits while being made reaches the context it is made for", async () => {
    const session = await start("m17n:t:latn-post");
    const records = (await session.request(2, new CreateEngine({ name: "m17n:hi:inscript" }))).filter(
      ({ record }) => record._tag !== "Log",
    );
    expect(records.length).toBeGreaterThan(0);
    expect(records.map(({ ic }) => ic)).toEqual(records.map(() => 2));
  });

  // The declaration has to hold the worst a page can do: every engine open at once.
  test("every engine open in one Worker stays within the declared heap", async () => {
    const session = await start("m17n:t:latn-post");
    for (const [index, { name }] of manifest.engines.entries()) await session.create(index + 2, name);
    for (let ic = 1; ic <= manifest.engines.length + 1; ic++) await typeText(session, ic, "a");

    const stats = await session.stats();
    h.record(`m17n ${runtime.name} every engine`, {
      engines: manifest.engines.length,
      heapPeak: stats.heapPeak,
      heapBytes: build.heapBytes,
    });
    expect(stats.heapPeak).toBeLessThanOrEqual(build.heapBytes);
  });
});
