// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { Property } from "@ibus-web/protocol/module-script";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import {
  defineEngine,
  defineModule,
  ModuleDefinitionError,
  type EngineContext,
  type EngineSession,
  type SettingsSchema,
} from "../src/index.ts";
import { recordingHost, type Call } from "./recording.ts";

const Settings = Schema.Struct({
  vowelPoints: Schema.Boolean.annotate({ default: true, property: { label: "Vowel points", symbol: "ניקוד" } }),
  scheme: Schema.Literals(["academic", "simple"]).annotate({
    default: "simple",
    property: { label: "Scheme", values: { academic: "Academic", simple: "Simple" } },
  }),
  plain: Schema.Boolean.annotate({ default: false }),
});

// A module of one engine named "hebrew", as a page would find it.
const open = (session: EngineSession = {}, create?: (context: EngineContext<typeof Settings>) => void) => {
  const hebrew = defineEngine({
    displayName: "Hebrew",
    languages: [],
    settings: Settings,
    create(context) {
      create?.(context);
      return session;
    },
  });
  const { engines } = defineModule({
    name: "t",
    version: "1",
    license: "MIT",
    settingsPrefix: "org.example",
    engines: { hebrew },
  });

  const host = recordingHost(engines.hebrew);
  return { host, ...host.open() };
};

const calls = (all: readonly Call[], method: string) => all.filter((call) => call.method === method).map((c) => c.args);

const bound: Property[] = [
  { key: "hebrew:vowel-points", kind: "toggle", label: "Vowel points", symbol: "ניקוד", state: "checked" },
  {
    key: "hebrew:scheme",
    kind: "menu",
    label: "Scheme",
    children: [
      { key: "hebrew:scheme:academic", kind: "radio", label: "Academic", state: "unchecked" },
      { key: "hebrew:scheme:simple", kind: "radio", label: "Simple", state: "checked" },
    ],
  },
];

describe("context.registerProperties", () => {
  test("sends the contract's whole properties, with checked turned into a state", () => {
    const { calls: recorded } = open();
    expect(calls(recorded, "registerProperties")).toEqual([[bound]]);

    const mine = open({}, (context) => {
      context.registerProperties([
        { key: "a", kind: "normal", label: "A", tooltip: "Tip", icon: "x", sensitive: false, visible: true },
        { key: "b", kind: "toggle", label: "B", checked: true },
        { key: "c", kind: "menu", label: "C", children: [{ key: "c1", kind: "radio", label: "C1", checked: false }] },
        { key: "s", kind: "separator", label: "" },
      ]);
    });

    expect(calls(mine.calls, "registerProperties")).toEqual([
      [
        [
          ...bound,
          { key: "a", kind: "normal", label: "A", tooltip: "Tip", icon: "x", sensitive: false, visible: true },
          { key: "b", kind: "toggle", label: "B", state: "checked" },
          {
            key: "c",
            kind: "menu",
            label: "C",
            children: [{ key: "c1", kind: "radio", label: "C1", state: "unchecked" }],
          },
          { key: "s", kind: "separator", label: "" },
        ],
      ],
    ]);
  });

  test("keeps the setting properties when the session registers again, replacing only its own", () => {
    let context!: EngineContext<typeof Settings>;
    const { calls: recorded } = open({}, (given) => (context = given));

    context.registerProperties([{ key: "a", kind: "normal", label: "A" }]);
    context.registerProperties([{ key: "b", kind: "normal", label: "B" }]);

    expect(calls(recorded, "registerProperties").at(-1)).toEqual([
      [...bound, { key: "b", kind: "normal", label: "B" }],
    ]);
  });

  test("refuses a key used twice or one a setting's property has", () => {
    let context!: EngineContext<typeof Settings>;
    open({}, (given) => (context = given));

    expect(() =>
      context.registerProperties([
        { key: "a", kind: "normal", label: "A" },
        { key: "a", kind: "normal", label: "A" },
      ]),
    ).toThrow('the property key "a" is used twice');
    expect(() => context.registerProperties([{ key: "hebrew:scheme", kind: "normal", label: "A" }])).toThrow(
      'the property key "hebrew:scheme" is used twice',
    );
  });
});

describe("context.updateProperty", () => {
  test("merges the changes into the registered property and sends all of it", () => {
    let context!: EngineContext<typeof Settings>;
    const { calls: recorded } = open({}, (given) => (context = given));
    context.registerProperties([{ key: "a", kind: "toggle", label: "A", tooltip: "Tip", checked: false }]);

    context.updateProperty("a", { checked: true, label: "Alpha" });
    context.updateProperty("a", { sensitive: false });

    expect(calls(recorded, "updateProperty")).toEqual([
      [{ key: "a", kind: "toggle", label: "Alpha", tooltip: "Tip", state: "checked" }],
      [{ key: "a", kind: "toggle", label: "Alpha", tooltip: "Tip", state: "checked", sensitive: false }],
    ]);
  });

  test("reaches a menu's child", () => {
    let context!: EngineContext<typeof Settings>;
    const { calls: recorded } = open({}, (given) => (context = given));
    context.registerProperties([
      { key: "m", kind: "menu", label: "M", children: [{ key: "m1", kind: "radio", label: "One" }] },
    ]);

    context.updateProperty("m1", { label: "Uno" });

    expect(calls(recorded, "updateProperty")).toEqual([[{ key: "m1", kind: "radio", label: "Uno" }]]);
  });

  test("refuses a change to undefined, which the host can't carry", () => {
    let context!: EngineContext<typeof Settings>;
    const { calls: recorded } = open({}, (given) => (context = given));
    context.registerProperties([{ key: "a", kind: "normal", label: "A", tooltip: "Tip" }]);

    expect(() => context.updateProperty("a", { tooltip: undefined } as never)).toThrow(
      'the property "a" can\'t have tooltip undefined',
    );
    context.updateProperty("a", { tooltip: "" });

    expect(calls(recorded, "updateProperty")).toEqual([[{ key: "a", kind: "normal", label: "A", tooltip: "" }]]);
  });

  test("refuses a change of key or kind, which would unbind a setting's property", () => {
    let context!: EngineContext<typeof Settings>;
    const { calls: recorded } = open({}, (given) => (context = given));

    expect(() => context.updateProperty("hebrew:vowel-points", { key: "x" } as never)).toThrow(
      'the property "hebrew:vowel-points" can\'t change its key or kind',
    );
    expect(() => context.updateProperty("hebrew:vowel-points", { kind: "normal" } as never)).toThrow(
      "can't change its key or kind",
    );
    expect(calls(recorded, "updateProperty")).toEqual([]);
  });

  test("names the remedy for the field a change to undefined hit", () => {
    let context!: EngineContext<typeof Settings>;
    open({}, (given) => (context = given));
    context.registerProperties([{ key: "a", kind: "normal", label: "A" }]);

    expect(() => context.updateProperty("a", { visible: undefined } as never)).toThrow(
      "can't have visible undefined: true restores it",
    );
    expect(() => context.updateProperty("a", { icon: undefined } as never)).toThrow('"" clears a text');
  });

  test("refuses a key that isn't registered", () => {
    let context!: EngineContext<typeof Settings>;
    const { calls: recorded } = open({}, (given) => (context = given));

    expect(() => context.updateProperty("nope", { label: "x" })).toThrow('the property "nope" isn\'t registered');
    expect(calls(recorded, "updateProperty")).toEqual([]);
  });
});

describe("settings that are properties", () => {
  test("register in every session of the engine when it is created, once", () => {
    const { host, calls: first } = open();
    const second = host.open();

    expect(calls(first, "registerProperties")).toEqual([[bound]]);
    expect(calls(second.calls, "registerProperties")).toEqual([[bound]]);
  });

  test("reflect the stored values when the session is created", () => {
    const hebrew = defineEngine({ displayName: "H", languages: [], settings: Settings, create: () => ({}) });
    const { engines } = defineModule({
      name: "t",
      version: "1",
      license: "MIT",
      settingsPrefix: "org.example",
      engines: { hebrew },
    });
    const host = recordingHost(engines.hebrew);
    host.values.set("vowel-points", false);
    host.values.set("scheme", "academic");

    const { calls: recorded } = host.open();
    const [[list]] = calls(recorded, "registerProperties") as [[Property[]]];

    expect(list![0]!.state).toBe("unchecked");
    expect(list![1]!.children!.map((radio) => radio.state)).toEqual(["checked", "unchecked"]);
  });

  test("a toggle's activation writes the state it is given, and nothing when the setting holds it already", () => {
    const { host, session } = open();

    session.propertyActivate!("hebrew:vowel-points", "unchecked");
    expect(host.written).toEqual([["vowel-points", false]]);

    session.propertyActivate!("hebrew:vowel-points", "unchecked");
    expect(host.written).toEqual([["vowel-points", false]]);

    session.propertyActivate!("hebrew:vowel-points", "checked");
    expect(host.written).toEqual([
      ["vowel-points", false],
      ["vowel-points", true],
    ]);
  });

  test("a radio's activation as checked selects its value, and any other activation writes nothing", () => {
    const { host, session } = open();

    session.propertyActivate!("hebrew:scheme:academic", "unchecked");
    session.propertyActivate!("hebrew:scheme:simple", "checked");
    expect(host.written).toEqual([]);

    session.propertyActivate!("hebrew:scheme:academic", "checked");
    session.propertyActivate!("hebrew:scheme:academic", "checked");

    expect(host.written).toEqual([["scheme", "academic"]]);
    expect(host.values.get("scheme")).toBe("academic");
  });

  test("follow a write by the session and a change by the page", () => {
    const { host, session, calls: recorded } = open();

    host.serve(() => session.propertyActivate!("hebrew:vowel-points", "unchecked"));
    host.change("scheme", "academic");
    host.change("vowel-points", true);

    expect(calls(recorded, "updateProperty")).toEqual([
      [{ key: "hebrew:vowel-points", kind: "toggle", label: "Vowel points", symbol: "ניקוד", state: "unchecked" }],
      [{ key: "hebrew:scheme:academic", kind: "radio", label: "Academic", state: "checked" }],
      [{ key: "hebrew:scheme:simple", kind: "radio", label: "Simple", state: "unchecked" }],
      [{ key: "hebrew:vowel-points", kind: "toggle", label: "Vowel points", symbol: "ניקוד", state: "checked" }],
    ]);
  });

  test("send nothing for a change of a setting that isn't a property", () => {
    const { host, calls: recorded } = open();
    host.change("plain", true);

    expect(calls(recorded, "updateProperty")).toEqual([]);
  });

  test("keep the session's updates to them", () => {
    let context!: EngineContext<typeof Settings>;
    const { host, calls: recorded } = open({}, (given) => (context = given));

    context.updateProperty("hebrew:vowel-points", { sensitive: false });
    host.change("vowel-points", false);

    expect(calls(recorded, "updateProperty").at(-1)).toEqual([
      expect.objectContaining({ sensitive: false, state: "unchecked" }),
    ]);
  });

  test("refuse a change of their state or radios, which follow the setting", () => {
    let context!: EngineContext<typeof Settings>;
    const { calls: recorded } = open({}, (given) => (context = given));

    for (const [key, changes] of [
      ["hebrew:vowel-points", { checked: false }],
      ["hebrew:scheme:simple", { checked: false }],
      ["hebrew:scheme", { children: [] }],
    ] as const)
      expect(() => context.updateProperty(key, changes)).toThrow("whose state and radios follow the setting");
    expect(calls(recorded, "updateProperty")).toEqual([]);
  });

  test("a session's propertyActivate hears only the keys that aren't bound", () => {
    const heard: [string, boolean][] = [];
    const { host, session } = open({ propertyActivate: (key, checked) => void heard.push([key, checked]) });

    session.propertyActivate!("hebrew:vowel-points", "unchecked");
    session.propertyActivate!("hebrew:scheme:academic", "checked");
    session.propertyActivate!("hebrew:scheme", "checked");
    session.propertyActivate!("mine", "checked");
    session.propertyActivate!("hebrew:nope", "unchecked");

    expect(heard).toEqual([
      ["mine", true],
      ["hebrew:nope", false],
    ]);
    expect(host.written.map(([key]) => key)).toEqual(["vowel-points", "scheme"]);
  });

  test("need an engine a module names", () => {
    const loose = defineEngine({ displayName: "H", languages: [], settings: Settings, create: () => ({}) });

    expect(() => recordingHost(loose).open()).toThrow("isn't in a module that names it");
  });

  test("take each name of an engine a module holds twice, and leave the engine itself unnamed", () => {
    const shared = defineEngine({ displayName: "H", languages: [], settings: Settings, create: () => ({}) });
    const { engines } = defineModule({
      name: "t",
      version: "1",
      license: "MIT",
      settingsPrefix: "org.example",
      engines: { first: shared, second: shared },
    });

    const keys = (engine: typeof shared) => {
      const [[list]] = calls(recordingHost(engine).open().calls, "registerProperties") as [[Property[]]];
      return list!.map((property) => property.key);
    };

    expect(keys(engines.first)).toEqual(["first:vowel-points", "first:scheme"]);
    expect(keys(engines.second)).toEqual(["second:vowel-points", "second:scheme"]);
    expect(engines.first.descriptor).toBe(shared.descriptor);
    expect(() => recordingHost(shared).open()).toThrow("isn't in a module that names it");
  });
});

describe("a focus change", () => {
  test("registers the setting properties and the session's own again on FocusIn", () => {
    let context!: EngineContext<typeof Settings>;
    const { session, calls: recorded } = open({}, (given) => (context = given));
    context.registerProperties([{ key: "a", kind: "normal", label: "A" }]);

    session.focusOut!();
    session.focusIn!();

    expect(calls(recorded, "registerProperties")).toEqual([
      [bound],
      [[...bound, { key: "a", kind: "normal", label: "A" }]],
      [[...bound, { key: "a", kind: "normal", label: "A" }]],
    ]);
  });

  test("registers them with the values the settings hold then", () => {
    const { host, session, calls: recorded } = open();
    session.focusOut!();
    host.change("vowel-points", false);
    session.focusIn!();

    const [list] = calls(recorded, "registerProperties").at(-1) as [Property[]];
    expect(list[0]!.state).toBe("unchecked");
  });

  test("registers once when the session's focusIn registers its own", () => {
    let context!: EngineContext<typeof Settings>;
    const { session, calls: recorded } = open(
      { focusIn: () => context.registerProperties([{ key: "b", kind: "normal", label: "B" }]) },
      (given) => (context = given),
    );

    session.focusIn!();

    expect(calls(recorded, "registerProperties")).toEqual([
      [bound],
      [[...bound, { key: "b", kind: "normal", label: "B" }]],
    ]);
  });

  test("sends nothing on the FocusIn that follows creation, which the creation already registered", () => {
    const { session, calls: recorded } = open();
    session.focusIn!();

    expect(calls(recorded, "registerProperties")).toEqual([[bound]]);
  });

  test("registers nothing for an engine without properties", () => {
    const host = recordingHost(defineEngine({ displayName: "T", languages: [], create: () => ({}) }));
    const { session, calls: recorded } = host.open();
    session.focusIn!();

    expect(calls(recorded, "registerProperties")).toEqual([]);
  });
});

describe("the property annotation", () => {
  const refused = (fields: Schema.Struct.Fields): ModuleDefinitionError => {
    try {
      defineEngine({
        displayName: "T",
        languages: [],
        settings: Schema.Struct(fields) as SettingsSchema,
        create: () => ({}),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ModuleDefinitionError);
      return error as ModuleDefinitionError;
    }
    throw new Error("defined without a refusal");
  };

  test("is refused on a field that is neither a boolean nor a literals", () => {
    const error = refused({
      size: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 9 })).annotate({
        default: 1,
        property: { label: "Size" },
      }),
    });
    expect(error.key).toBe("size");
    expect(error.reason).toBe("has a property annotation, but only a boolean or a literals setting can be a property");

    refused({ name: Schema.String.annotate({ default: "", property: { label: "Name" } }) });
    refused({ words: Schema.Array(Schema.String).annotate({ default: [], property: { label: "Words" } }) });
  });

  test("is refused when a literals field doesn't label each value, or a boolean has values", () => {
    const values = { a: "A" };
    const choices = Schema.Literals(["a", "b"]);

    expect(refused({ x: choices.annotate({ default: "a", property: { label: "X", values } }) }).reason).toContain(
      'no label for ["b"]',
    );
    expect(
      refused({ x: choices.annotate({ default: "a", property: { label: "X", values: { a: "A", b: "B", c: "C" } } }) })
        .reason,
    ).toContain('["c"] isn\'t a choice');
    expect(refused({ x: choices.annotate({ default: "a", property: { label: "X" } }) }).reason).toContain(
      "without a label for each of its values",
    );
    expect(
      refused({ x: Schema.Boolean.annotate({ default: true, property: { label: "X", values } }) }).reason,
    ).toContain("a boolean setting is a toggle");
  });

  test("is refused with a label, symbol or value label that isn't text the host can carry", () => {
    const choices = Schema.Literals(["a", "b"]);

    expect(refused({ x: Schema.Boolean.annotate({ default: true, property: { label: "a\0" } }) }).reason).toBe(
      'has a property label "a\\u0000", which isn\'t text',
    );
    expect(
      refused({ x: Schema.Boolean.annotate({ default: true, property: { label: "X", symbol: "\ud800" } }) }).reason,
    ).toContain("has a property symbol");
    expect(
      refused({ x: Schema.Boolean.annotate({ default: true, property: { label: 5 as never } }) }).reason,
    ).toContain("has a property label 5");
    expect(
      refused({
        x: choices.annotate({ default: "a", property: { label: "X", values: { a: "A", b: { text: "B" } as never } } }),
      }).reason,
    ).toBe('has a property label {"text":"B"} for "b", which isn\'t text');

    defineEngine({
      displayName: "T",
      languages: [],
      settings: Schema.Struct({
        x: Schema.Boolean.annotate({ default: true, property: { label: { text: "X", attributes: [] } } }),
      }),
      create: () => ({}),
    });
  });

  test.each([
    ["an unknown type", { type: "bogus", value: 0, start: 0, end: 1 }],
    ["a fractional value", { type: "hint", value: 0.5, start: 0, end: 1 }],
    ["a start after its end", { type: "underline", value: 1, start: 2, end: 1 }],
    ["a negative start", { type: "underline", value: 1, start: -1, end: 1 }],
    ["a missing end", { type: "underline", value: 1, start: 0 }],
    ["not an object", 5],
  ])("is refused with a label holding an attribute with %s", (_, attribute) => {
    expect(
      refused({
        x: Schema.Boolean.annotate({
          default: true,
          property: { label: { text: "X", attributes: [attribute as never] } },
        }),
      }).reason,
    ).toContain("has a property label");
  });

  test("accepts a label with well-formed attributes", () => {
    defineEngine({
      displayName: "T",
      languages: [],
      settings: Schema.Struct({
        x: Schema.Boolean.annotate({
          default: true,
          property: { label: { text: "X", attributes: [{ type: "underline", value: 1, start: 0, end: 1 }] } },
        }),
      }),
      create: () => ({}),
    });
  });

  test("is refused without a label", () => {
    expect(refused({ x: Schema.Boolean.annotate({ default: true, property: {} as { label: string } }) }).reason).toBe(
      "has a property annotation without a label",
    );
  });
});
