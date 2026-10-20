// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The host as released, serving a module written with the kit: a transform
// engine whose settings are a toggle and a menu of radios, and an engine that
// pages candidates and answers through Effect handlers. Each step is a
// request, the reply the page reads and the records the host writes for it.

import {
  booleanVariant,
  CandidateClicked,
  CreateEngine,
  CursorDown,
  CursorUp,
  DestroyEngine,
  FocusIn,
  FocusOut,
  Init,
  PageDown,
  PageUp,
  ProcessKeyEvent,
  PropertyActivate,
  SettingChanged,
  stringVariant,
  type Request,
} from "@ibus-web/protocol";
import { afterAll, beforeAll, expect, test } from "vitest";
import { next, page, start } from "./js-host.ts";
import { bundleKitModule, type BundledKitModule } from "./kit-module.ts";

const ENOENT = 44;
const ECANCELED = 11;

const greekPath = "/org/example/kitfixture/greek/";

const key = (character: string) => new ProcessKeyEvent({ keyval: character.codePointAt(0)!, keycode: 0, state: 0 });

const plain = (text: string) => ({ text, attrs: { attributes: [] } });

// The composition as the transform engine shows it: underlined over all of
// it, with the raw buffer beneath.
const composing = (shown: string, raw: string) => [
  {
    _tag: "UpdatePreeditText",
    text: {
      text: shown,
      attrs: { attributes: [{ type: 1, value: 1, startIndex: 0, endIndex: [...shown].length }] },
    },
    cursor: [...shown].length,
    visible: true,
    mode: 1,
  },
  { _tag: "UpdateAuxiliaryText", text: plain(raw), visible: true },
];

const cleared = [
  { _tag: "UpdatePreeditText", text: plain(""), cursor: 0, visible: false, mode: 0 },
  { _tag: "UpdateAuxiliaryText", text: plain(""), visible: false },
];

const finalSigma = (on: boolean) => ({
  key: "greek:final-sigma",
  type: 1,
  label: plain("Final sigma"),
  symbol: plain("ς"),
  state: on ? 1 : 0,
});

const radio = (value: "lower" | "upper", on: boolean) => ({
  key: `greek:letter-case:${value}`,
  type: 2,
  label: plain(value === "lower" ? "Lowercase" : "Uppercase"),
  state: on ? 1 : 0,
});

const letterCase = (value: "lower" | "upper") => ({
  key: "greek:letter-case",
  type: 3,
  label: plain("Case"),
  subProps: { properties: [radio("lower", value === "lower"), radio("upper", value === "upper")] },
});

const registered = (sigma: boolean, value: "lower" | "upper") => ({
  _tag: "RegisterProperties",
  properties: { properties: [finalSigma(sigma), letterCase(value)] },
});

const table = (words: readonly string[], cursor = 0) => ({
  _tag: "UpdateLookupTable",
  table: { pageSize: 10, cursorPos: cursor, cursorVisible: true, candidates: words.map(plain) },
  visible: true,
});

const greekSettings = (values: Readonly<Record<string, unknown>> = {}) =>
  new Init({
    version: 1,
    userDataWritable: false,
    settings: [{ schemaId: "org.example.kitfixture.greek", path: greekPath, values }],
    patterns: [],
  });

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `word${from + index}`);

// A request on ic, the reply it should get, and the records it should write
// on ic, in order.
type Step = readonly [number, Request, number, readonly object[]];

const trace: readonly Step[] = [
  [0, greekSettings(), 0, []],
  [1, new CreateEngine({ name: "greek" }), 0, [registered(true, "lower")]],

  // The transform runs over the whole buffer on each key, so the sigma
  // changes with the letter after it.
  [1, key("s"), 1, composing("σ", "s")],
  [1, key("a"), 1, composing("σα", "sa")],
  [1, key("s"), 1, composing("σας", "sas")],
  [1, key("a"), 1, composing("σασα", "sasa")],
  [1, key("s"), 1, composing("σασας", "sasas")],

  // The page's toggle writes the setting and redraws the composition.
  [
    1,
    new PropertyActivate({ name: "greek:final-sigma", state: 0 }),
    0,
    [
      { _tag: "SettingWritten", path: greekPath, key: "final-sigma" },
      { _tag: "UpdateProperty", property: finalSigma(false) },
      ...composing("σασασ", "sasas"),
    ],
  ],
  [
    1,
    new SettingChanged({ path: greekPath, key: "final-sigma", value: booleanVariant(true) }),
    0,
    [{ _tag: "UpdateProperty", property: finalSigma(true) }, ...composing("σασας", "sasas")],
  ],

  // A space ends the composition: it commits the text and passes through.
  [1, key(" "), 0, [{ _tag: "CommitText", text: plain("σασας") }, ...cleared]],

  // The panel drops a context's properties on blur, so the kit registers
  // them again on the next focus.
  [1, new FocusOut({}), 0, [{ _tag: "UpdateAuxiliaryText", text: plain(""), visible: false }]],
  [1, new FocusIn({}), 0, [registered(true, "lower")]],

  // A radio's activation writes the menu's setting, and the kit updates the
  // radios whose state changed.
  [
    1,
    new PropertyActivate({ name: "greek:letter-case:upper", state: 1 }),
    0,
    [
      { _tag: "SettingWritten", path: greekPath, key: "letter-case" },
      { _tag: "UpdateProperty", property: radio("lower", false) },
      { _tag: "UpdateProperty", property: radio("upper", true) },
    ],
  ],
  [1, key("s"), 1, composing("Σ", "s")],
  [1, key("a"), 1, composing("ΣΑ", "sa")],

  // A transform that throws is no fault: the kit shows the raw buffer and
  // logs one warning in the module's domain, then commits the raw word at
  // its end.
  [
    1,
    key("j"),
    1,
    [
      {
        _tag: "Log",
        level: 16,
        domain: "kit-fixture",
        message: "the transform failed, so the raw input is used: Greek has no letter j",
      },
      ...composing("saj", "saj"),
    ],
  ],
  [1, key("a"), 1, composing("saja", "saja")],
  [1, key(" "), 0, [{ _tag: "CommitText", text: plain("saja") }, ...cleared]],
  [1, new FocusOut({}), 0, [{ _tag: "UpdateAuxiliaryText", text: plain(""), visible: false }]],
  [1, new FocusIn({}), 0, [registered(true, "upper")]],

  [2, new CreateEngine({ name: "words" }), 0, []],
  [2, key("w"), 1, [table(range(0, 10))]],
  [2, new PageDown({}), 0, [table(range(10, 20))]],
  [2, new PageUp({}), 0, [table(range(0, 10))]],
  [2, new PageUp({}), 0, []],
  [2, new CursorDown({}), 0, [table(range(0, 10), 1)]],
  [2, new CursorUp({}), 0, [table(range(0, 10))]],
  [2, new PageDown({}), 0, [table(range(10, 20))]],

  // The click is on the page, and the kit maps it to the list: the third
  // candidate of the second page is the list's thirteenth.
  [
    2,
    new CandidateClicked({ index: 2, button: 1, state: 0 }),
    0,
    [
      { _tag: "CommitText", text: plain("word12") },
      { _tag: "UpdateLookupTable", table: { candidates: [] }, visible: false },
    ],
  ],
  [2, key("!"), 0, []],

  [1, new DestroyEngine({}), 0, []],
  [2, new DestroyEngine({}), 0, []],
  [1, key("a"), -ENOENT, []],
];

let bundle: BundledKitModule;
beforeAll(async () => {
  bundle = await bundleKitModule();
});
afterAll(() => bundle.remove());

test("the kit's build writes the fixture's manifest from its script", () => {
  expect(bundle.manifest).toMatchObject({
    kind: "js",
    name: "kit-fixture",
    version: expect.stringMatching(/^1\.0\.0\+js\.[0-9a-f]{16}$/),
    module: { url: expect.stringMatching(/\/module\.[0-9a-f]{16}\.js$/) },
    engines: [{ name: "greek" }, { name: "words" }],
    settingsSchemas: ["org.example.kitfixture.greek"],
    settingsMetadata: { url: "./settings.json" },
  });
});

test("a host serves a module written with the kit through every kind of request", async () => {
  const { worker, control, message } = await start(bundle.manifest);
  try {
    expect(message).toMatchObject({ type: "ready" });

    const host = page(control);
    for (const [index, [ic, request, ret, records]] of trace.entries()) {
      const served = await host.request(ic, request);
      const label = `step ${index}: ${request._tag}`;

      expect({ label, ret: served.ret }).toEqual({ label, ret });
      expect({ label, records: served.records.map((served) => served.record) }).toMatchObject({ label, records });
      expect(served.records.every((served) => served.ic === ic)).toBe(true);
    }
  } finally {
    await worker.terminate();
  }
});

test("a host registers a kit engine's setting properties with the values the page gives at Init", async () => {
  const { worker, control } = await start(bundle.manifest);
  try {
    const host = page(control);
    await host.request(
      0,
      greekSettings({ "final-sigma": booleanVariant(false), "letter-case": stringVariant("upper") }),
    );

    const created = await host.request(1, new CreateEngine({ name: "greek" }));
    expect(created.records.map((served) => served.record)).toMatchObject([registered(false, "upper")]);
  } finally {
    await worker.terminate();
  }
});

test("a handler's failing Effect is a fault that crashes the host", async () => {
  const { worker, control } = await start(bundle.manifest);
  try {
    const host = page(control);
    await host.request(0, greekSettings());
    await host.request(2, new CreateEngine({ name: "words" }));

    const crashed = next(worker);
    const served = await host.request(2, key("#"));
    const message = expect.stringContaining("the picker has no key #");

    expect(served.ret).toBe(-ECANCELED);
    expect(await crashed).toEqual({ type: "crashed", message });
    expect([...served.records, ...host.records()].map((served) => served.record)).toMatchObject([
      { _tag: "Crashed", reason: 2, message },
    ]);
  } finally {
    await worker.terminate();
  }
});

test("a module's start is refused when its manifest isn't the script's", async () => {
  const wrong = { ...bundle.manifest, settingsSchemas: [] };
  const { worker, message } = await start(wrong);
  try {
    expect(message).toMatchObject({ type: "error" });
  } finally {
    await worker.terminate();
  }
});
