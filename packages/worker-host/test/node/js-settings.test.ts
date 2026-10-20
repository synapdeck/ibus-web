// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The host as released, keeping the fixture script's settings: Init's values
// as the engines read them, a value Init stores that its key refuses, the
// page's changes reaching every session and each one refused, and a
// session's write, which the page persists and the other sessions hear of.

import {
  booleanVariant,
  CreateEngine,
  Init,
  int32Variant,
  ProcessKeyEvent,
  PropertyActivate,
  SettingChanged,
  stringVariant,
  variant,
  type GVariantValue,
} from "@ibus-web/protocol";
import { expect, test } from "vitest";
import { manifest, page, start, type Served } from "./js-host.ts";

const EINVAL = 28;
const ENOENT = 44;

const upperPath = "/org/example/jsfixture/upper/";
const pickPath = "/org/example/jsfixture/pick/";

type Values = Record<string, Extract<GVariantValue, { _tag: "v" }>>;

const init = (upper: Values | undefined, pick: Values | undefined, patterns: Init["patterns"] = []) =>
  new Init({
    version: 1,
    userDataWritable: false,
    settings: [
      ...(upper === undefined ? [] : [{ schemaId: "org.example.jsfixture.upper", path: upperPath, values: upper }]),
      ...(pick === undefined ? [] : [{ schemaId: "org.example.jsfixture.pick", path: pickPath, values: pick }]),
    ],
    patterns,
  });

const strings = (...items: string[]) =>
  variant("as", { _tag: "a", items: items.map((value) => ({ _tag: "s", value })) });
const double = (value: number) => variant("d", { _tag: "d", value });

const key = (character: string) => new ProcessKeyEvent({ keyval: character.codePointAt(0)!, keycode: 0, state: 0 });

const plain = (text: string) => ({ text, attrs: { attributes: [] } });
const underlined = (text: string) => ({
  text,
  attrs: { attributes: [{ type: 1, value: 1, startIndex: 0, endIndex: [...text].length }] },
});

const warning = (message: string) => [0, { _tag: "Log", level: 16, domain: "ibus-web", message }] as const;

// What the upper engine writes as `shout` reads `on`: its toggle, and its
// composition redrawn, empty.
const shoutProperty = (on: boolean) => ({
  key: "shout",
  type: 1,
  label: plain("Shout"),
  symbol: plain("A"),
  tooltip: plain("Uppercase the composition"),
  state: on ? 1 : 0,
});
const shoutChanged = (ic: number, on: boolean) =>
  [
    [ic, { _tag: "UpdateProperty", property: shoutProperty(on) }],
    [ic, { _tag: "UpdatePreeditText", text: underlined(""), cursor: 0, visible: false, mode: 1 }],
  ] as const;

// What the pick engine shows for a letter.
const offered = (ic: number, letter: string, candidates: readonly string[]) =>
  [
    [
      ic,
      {
        _tag: "UpdateLookupTable",
        table: {
          candidates: candidates.map(plain),
          labels: candidates.map((_, index) => plain(`${index + 1}.`)),
        },
        visible: true,
      },
    ],
    [ic, { _tag: "UpdateAuxiliaryText", text: underlined(letter), visible: true }],
  ] as const;

const expectServed = (served: Served, ret: number, records: readonly (readonly [number, object])[]) => {
  expect(served.ret).toBe(ret);
  expect(served.records.map(({ ic, record }) => [ic, record])).toMatchObject(records);
};

const running = async () => {
  const { worker, control, message } = await start(manifest);
  expect(message).toMatchObject({ type: "ready" });
  return { worker, host: page(control) };
};

test("the engines read Init's values, and a key's default where Init stores none", async () => {
  const { worker, host } = await running();
  try {
    expectServed(
      await host.request(0, init({ shout: booleanVariant(false) }, { count: int32Variant(2), extras: strings("xx") })),
      0,
      [],
    );

    expectServed(await host.request(1, new CreateEngine({ name: "upper" })), 0, [
      [1, { _tag: "RegisterProperties", properties: { properties: [shoutProperty(false)] } }],
    ]);
    expectServed(await host.request(2, new CreateEngine({ name: "pick" })), 0, []);
    expectServed(await host.request(2, key("a")), 1, offered(2, "a", ["a", "aa", "xx"]));
  } finally {
    await worker.terminate();
  }
});

test("a value Init stores that its key refuses is skipped for the default, with one warning", async () => {
  const { worker, host } = await running();
  try {
    expectServed(
      await host.request(
        0,
        new Init({
          version: 1,
          userDataWritable: false,
          settings: [
            {
              schemaId: "org.example.jsfixture.pick",
              path: pickPath,
              values: {
                count: int32Variant(12),
                case: stringVariant("shouty"),
                extras: int32Variant(1),
                lines: int32Variant(1),
              },
            },
            { schemaId: "org.example.jsfixture.upper", path: upperPath, values: { delay: int32Variant(2) } },
            { schemaId: "org.example.jsfixture.upper", path: "/org/example/other/", values: {} },
            { schemaId: "org.example.jsfixture.trace", path: "/org/example/jsfixture/trace/", values: {} },
            { schemaId: "org.example.jsfixture.pick", path: "pick", values: {} },
          ],
          patterns: [
            { schemaId: "org.example.jsfixture.upper", pattern: "/org/example/{name}/" },
            { schemaId: "org.example.jsfixture.upper", pattern: "/org/example/" },
          ],
        }),
      ),
      0,
      [
        warning(
          "Settings schema org.example.jsfixture.upper has the fixed path /org/example/jsfixture/upper/, not a pattern",
        ),
        warning("Invalid settings pattern: /org/example/"),
        warning(`Invalid value for settings key: ${pickPath}count`),
        warning(`Invalid value for settings key: ${pickPath}case`),
        warning(`Invalid value for settings key: ${pickPath}extras`),
        warning(`Unknown settings key: ${pickPath}lines`),
        warning(`Invalid value for settings key: ${upperPath}delay`),
        warning(
          "Settings schema org.example.jsfixture.upper has the fixed path /org/example/jsfixture/upper/, not /org/example/other/",
        ),
        warning("Unknown settings schema: org.example.jsfixture.trace"),
        warning("Invalid settings path: pick"),
      ],
    );

    expectServed(await host.request(1, new CreateEngine({ name: "pick" })), 0, []);
    expectServed(await host.request(1, key("b")), 1, offered(1, "b", ["b", "bb", "bbb"]));
  } finally {
    await worker.terminate();
  }
});

test("the page's change reaches every session of the key's engine, and an equal value none", async () => {
  const { worker, host } = await running();
  try {
    expectServed(await host.request(0, init({}, {})), 0, []);
    for (const [ic, name] of [
      [1, "upper"],
      [2, "pick"],
      [3, "upper"],
    ] as const)
      expect((await host.request(ic, new CreateEngine({ name }))).ret).toBe(0);

    const change = new SettingChanged({ path: upperPath, key: "shout", value: booleanVariant(false) });
    expectServed(await host.request(2, change), 0, [...shoutChanged(1, false), ...shoutChanged(3, false)]);
    expectServed(await host.request(2, change), 0, []);

    expectServed(
      await host.request(0, new SettingChanged({ path: pickPath, key: "extras", value: strings("ab", "cd") })),
      0,
      [],
    );
    expectServed(
      await host.request(0, new SettingChanged({ path: pickPath, key: "case", value: stringVariant("upper") })),
      0,
      [],
    );
    expectServed(await host.request(2, key("q")), 1, offered(2, "Q", ["Q", "QQ", "QQQ", "ab", "cd"]));
  } finally {
    await worker.terminate();
  }
});

test("a change the store refuses returns the runtime's errno, with a warning, and changes nothing", async () => {
  const { worker, host } = await running();
  try {
    expectServed(await host.request(0, init(undefined, {})), 0, []);
    expect((await host.request(1, new CreateEngine({ name: "pick" }))).ret).toBe(0);

    const refusals = [
      [upperPath, "shout", booleanVariant(false), -ENOENT, `Unknown settings path: ${upperPath}`],
      ["/org/example/elsewhere/", "count", int32Variant(4), -ENOENT, "Unknown settings path: /org/example/elsewhere/"],
      [pickPath, "lines", int32Variant(4), -ENOENT, `Unknown settings key: ${pickPath}lines`],
      [pickPath, "count", stringVariant("4"), -EINVAL, `Invalid value for settings key: ${pickPath}count`],
      [pickPath, "count", int32Variant(10), -EINVAL, `Invalid value for settings key: ${pickPath}count`],
      [pickPath, "count", int32Variant(0), -EINVAL, `Invalid value for settings key: ${pickPath}count`],
      [pickPath, "count", double(4), -EINVAL, `Invalid value for settings key: ${pickPath}count`],
      [pickPath, "case", stringVariant("mixed"), -EINVAL, `Invalid value for settings key: ${pickPath}case`],
      [pickPath, "extras", stringVariant("ab"), -EINVAL, `Invalid value for settings key: ${pickPath}extras`],
    ] as const;
    for (const [path, name, value, ret, message] of refusals)
      expectServed(await host.request(1, new SettingChanged({ path, key: name, value })), ret, [warning(message)]);

    expectServed(await host.request(1, key("c")), 1, offered(1, "c", ["c", "cc", "ccc"]));
  } finally {
    await worker.terminate();
  }
});

test("a session's write is persisted and told to every session of its engine once its handler returns", async () => {
  const { worker, host } = await running();
  try {
    expectServed(await host.request(0, init({}, {})), 0, []);
    expect((await host.request(1, new CreateEngine({ name: "upper" }))).ret).toBe(0);
    expect((await host.request(2, new CreateEngine({ name: "upper" }))).ret).toBe(0);
    expect((await host.request(3, new CreateEngine({ name: "pick" }))).ret).toBe(0);

    const written = (on: boolean) =>
      [2, { _tag: "SettingWritten", path: upperPath, key: "shout", value: booleanVariant(on) }] as const;
    expectServed(await host.request(2, new PropertyActivate({ name: "shout", state: 0 })), 0, [
      written(false),
      ...shoutChanged(1, false),
      ...shoutChanged(2, false),
    ]);
    expectServed(await host.request(2, new PropertyActivate({ name: "shout", state: 0 })), 0, [written(false)]);
    expectServed(await host.request(1, new PropertyActivate({ name: "shout", state: 1 })), 0, [
      [1, { _tag: "SettingWritten", path: upperPath, key: "shout", value: booleanVariant(true) }],
      ...shoutChanged(1, true),
      ...shoutChanged(2, true),
    ]);
  } finally {
    await worker.terminate();
  }
});

test("a session's write to an instance Init didn't declare is refused with a warning", async () => {
  const { worker, host } = await running();
  try {
    expectServed(await host.request(0, init(undefined, undefined)), 0, []);
    expect((await host.request(1, new CreateEngine({ name: "upper" }))).ret).toBe(0);

    expectServed(await host.request(1, new PropertyActivate({ name: "shout", state: 0 })), 0, [
      warning(`Unknown settings path: ${upperPath}shout`),
    ]);
  } finally {
    await worker.terminate();
  }
});
