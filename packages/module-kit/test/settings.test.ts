// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vitest";
import { settingFields } from "../src/engine.ts";
import {
  defineEngine,
  defineModule,
  ModuleDefinitionError,
  type EngineContext,
  type SettingsSchema,
} from "../src/index.ts";
import { recordingHost } from "./recording.ts";

const engine = <S extends SettingsSchema>(settings: S, create: (context: EngineContext<S>) => object = () => ({})) =>
  defineEngine({ displayName: "Test", languages: [], settings, create });

const declarations = (fields: Schema.Struct.Fields) => engine(Schema.Struct(fields)).settings;

// The error defineEngine throws, which must not be a TypeError: the host
// reads one thrown during import as a failed fetch.
const refusal = (settings: unknown): ModuleDefinitionError => {
  try {
    engine(settings as SettingsSchema);
  } catch (error) {
    expect(error).toBeInstanceOf(ModuleDefinitionError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as ModuleDefinitionError)._tag).toBe("ModuleDefinitionError");
    expect((error as ModuleDefinitionError).engine).toBeUndefined();
    return error as ModuleDefinitionError;
  }
  throw new Error("defined without a refusal");
};

describe("a settings struct's fields", () => {
  test("map to the contract's types, with their defaults, summaries and descriptions", () => {
    expect(
      declarations({
        vowelPoints: Schema.Boolean.annotate({ default: true, title: "Write vowel points", description: "Niqqud" }),
        name: Schema.String.annotate({ default: "" }),
        scheme: Schema.Literals(["academic", "simple"]).annotate({ default: "simple" }),
        pageSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })).annotate({ default: 10 }),
        scale: Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 2 })).annotate({ default: 1 }),
        words: Schema.Array(Schema.String).annotate({ default: ["a", "b"] }),
      }),
    ).toEqual({
      "vowel-points": { type: "b", default: true, summary: "Write vowel points", description: "Niqqud" },
      name: { type: "s", default: "" },
      scheme: { type: "s", default: "simple", choices: ["academic", "simple"] },
      "page-size": { type: "i", default: 10, range: { min: 1, max: 16 } },
      scale: { type: "d", default: 1, range: { min: 0.5, max: 2 } },
      words: { type: "as", default: ["a", "b"] },
    });
  });

  test("keep their order", () => {
    const flag = Schema.Boolean.annotate({ default: false });

    expect(Object.keys(declarations({ zeta: flag, alpha: flag, midWay: flag })!)).toEqual(["zeta", "alpha", "mid-way"]);
  });

  test("take the annotations given before or after their checks", () => {
    const before = Schema.Number.annotate({ default: 3, title: "Before" }).check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: 5 }),
    );
    const after = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 5 })).annotate({
      default: 4,
      title: "After",
    });

    expect(declarations({ before, after })).toEqual({
      before: { type: "i", default: 3, summary: "Before", range: { min: 0, max: 5 } },
      after: { type: "i", default: 4, summary: "After", range: { min: 0, max: 5 } },
    });
  });

  test("narrow a range to every isBetween check, isInt32's included", () => {
    expect(
      declarations({
        level: Schema.Number.check(Schema.isInt32(), Schema.isBetween({ minimum: -5, maximum: 1e12 })).annotate({
          default: 0,
        }),
        any: Schema.Number.check(Schema.isInt32()).annotate({ default: 0 }),
      }),
    ).toEqual({
      level: { type: "i", default: 0, range: { min: -5, max: 0x7fffffff } },
      any: { type: "i", default: 0, range: { min: -0x80000000, max: 0x7fffffff } },
    });
  });

  test("map an integer without a range to a 32-bit one, and a number without one to an unbounded double", () => {
    expect(
      declarations({
        count: Schema.Int.annotate({ default: 1 }),
        least: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ default: 0 }),
        most: Schema.Int.check(Schema.isLessThanOrEqualTo(9)).annotate({ default: 0 }),
        scale: Schema.Number.annotate({ default: 1.5, title: "Scale" }),
        finite: Schema.Finite.annotate({ default: 0 }),
      }),
    ).toEqual({
      count: { type: "i", default: 1, range: { min: -0x80000000, max: 0x7fffffff } },
      least: { type: "i", default: 0, range: { min: 0, max: 0x7fffffff } },
      most: { type: "i", default: 0, range: { min: -0x80000000, max: 9 } },
      scale: { type: "d", default: 1.5, summary: "Scale" },
      finite: { type: "d", default: 0 },
    });
  });

  test("take the last of an annotation given more than once", () => {
    const field = Schema.Int.annotate({ title: "First", default: 1 })
      .check(Schema.isBetween({ minimum: 0, maximum: 5 }))
      .annotate({ title: "Last" });

    expect(declarations({ field })).toEqual({
      field: { type: "i", default: 1, summary: "Last", range: { min: 0, max: 5 } },
    });
  });

  test("read choices from a union of string literals and ignore an identifier", () => {
    expect(
      declarations({
        scheme: Schema.Union([Schema.Literal("a"), Schema.Literal("b")]).annotate({ default: "b" }),
        name: Schema.String.annotate({ identifier: "Name", default: "x" }),
      }),
    ).toEqual({
      scheme: { type: "s", default: "b", choices: ["a", "b"] },
      name: { type: "s", default: "x" },
    });
  });

  test("stay reachable by name from the engine, apart from the contract's declarations", () => {
    const vowelPoints = Schema.Boolean.annotate({ default: true });
    const defined = engine(Schema.Struct({ vowelPoints }));

    expect(settingFields(defined)).toEqual({ vowelPoints });
    expect(settingFields(defined)!.vowelPoints).toBe(vowelPoints);
    expect(Object.keys(defined)).toEqual(["descriptor", "settings", "create"]);
    expect(defined.settings).toEqual({ "vowel-points": { type: "b", default: true } });
    expect(settingFields(defineEngine({ displayName: "T", languages: [], create: () => ({}) }))).toBeUndefined();

    const { engines } = defineModule({
      name: "t",
      version: "1",
      license: "MIT",
      settingsPrefix: "org.example",
      engines: { test: defined },
    });

    expect(settingFields(engines.test)!.vowelPoints).toBe(vowelPoints);
  });

  test("copy a list's default", () => {
    const words = ["a"];
    const declared = declarations({ words: Schema.Array(Schema.String).annotate({ default: words }) });
    words.push("b");

    expect(declared!.words!.default).toEqual(["a"]);
  });
});

describe("defineEngine refuses", () => {
  test.each([
    ["vowel_points", "an underscore"],
    ["vowel-points", "a - of its own, whose key wouldn't map back to it"],
    ["VowelPoints", "a leading uppercase letter"],
    ["2nd", "a leading digit"],
    ["a".repeat(33), "33 characters"],
    ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaB", "33 characters once mapped"],
    ["", "no characters"],
  ])("the setting name %j, with %s", (name) => {
    const error = refusal(Schema.Struct({ [name]: Schema.Boolean.annotate({ default: true }) }));
    const reason =
      "doesn't map to a GSettings key: its name must be a lowercase letter, then letters and digits, at most 32 " +
      "characters once each uppercase letter is written as - and its lowercase";

    expect(error.key).toBe(name);
    expect(error.reason).toBe(reason);
    expect(error.message).toBe(`the setting ${JSON.stringify(name)} ${reason}`);
  });

  test.each(["a", "v2", "vowelPoints", "a2B", "aBC", "a".repeat(32), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaB"])(
    "not the setting name %j",
    (name) => {
      expect(Object.keys(declarations({ [name]: Schema.Boolean.annotate({ default: true }) })!)).toHaveLength(1);
    },
  );

  test.each([
    ["no default", Schema.Boolean, "has no default annotation"],
    ["a default of another type", Schema.Boolean.annotate({ default: "yes" as never }), 'has the default "yes"'],
    [
      "a default outside its choices",
      Schema.Literals(["a", "b"]).annotate({ default: "c" as never }),
      'has the default "c", which its schema rejects',
    ],
    [
      "a default outside its range",
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })).annotate({ default: 5 }),
      "has the default 5, which its schema rejects",
    ],
    [
      "an integer's default beyond 32 bits",
      Schema.Int.annotate({ default: 2 ** 31 }),
      "has the default 2147483648, outside its range",
    ],
    [
      "an integer's fractional default",
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })).annotate({ default: 1.5 }),
      "has the default 1.5, which its schema rejects",
    ],
    [
      "a list's default of numbers",
      Schema.Array(Schema.String).annotate({ default: [1] as never }),
      "has the default [1], which its schema rejects",
    ],
    [
      "a default holding NUL",
      Schema.String.annotate({ default: "a\0" }),
      'has the default "a\\u0000", which isn\'t text',
    ],
    [
      "a range with its min above its max",
      Schema.Number.check(Schema.isBetween({ minimum: 3, maximum: 1 })).annotate({ default: 2 }),
      "has the range 3 to 1, which no value meets",
    ],
    [
      "a number with only a minimum",
      Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ default: 1 }),
      "has only a minimum, but a range needs both bounds",
    ],
    [
      "an exclusive bound",
      Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1, exclusiveMaximum: true })).annotate({
        default: 0,
      }),
      "has an exclusive bound",
    ],
    [
      "an integer range beyond 32 bits",
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** 32 })).annotate({ default: 0 }),
      "has the range 0 to 4294967296, beyond a 32-bit integer's",
    ],
    [
      "a number with another check",
      Schema.Number.check(Schema.isMultipleOf(2), Schema.isBetween({ minimum: 0, maximum: 4 })).annotate({
        default: 2,
      }),
      "has the JSON Schema constraint multipleOf, which GSettings can't hold",
    ],
    [
      "an exclusive lower bound",
      Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1)).annotate({ default: 1 }),
      "has an exclusive bound",
    ],
    [
      "a check JSON Schema can't express",
      Schema.Number.check(Schema.makeFilter((value) => value > 0)).annotate({ default: 1 }),
      "has a check JSON Schema can't express, which GSettings can't either",
    ],
    [
      "a list of strings with a check JSON Schema can't express",
      Schema.Array(Schema.String.check(Schema.makeFilter((value) => value !== ""))).annotate({ default: [] }),
      "has a check JSON Schema can't express",
    ],
    [
      "a string with a check",
      Schema.String.check(Schema.isMinLength(1)).annotate({ default: "a" }),
      "has the JSON Schema constraint minLength",
    ],
    [
      "a union of other than string literals",
      Schema.Union([Schema.Literal("a"), Schema.Literal(1)]).annotate({ default: "a" }),
      "isn't a Boolean, a String, Literals of strings, a Number or an integer, or an Array of String",
    ],
    [
      "a union of strings and booleans",
      Schema.Union([Schema.String, Schema.Boolean]).annotate({ default: "a" }),
      "isn't a Boolean, a String",
    ],
    ["a boolean literal", Schema.Literal(true).annotate({ default: true }), "has choices that aren't strings"],
    ["number literals", Schema.Literals([1, 2]).annotate({ default: 1 }), "has choices that aren't strings"],
    [
      "repeated choices",
      Schema.Literals(["a", "a"]).annotate({ default: "a" }),
      'has the choices ["a","a"], which repeat a value',
    ],
    [
      "an array of numbers",
      Schema.Array(Schema.Number).annotate({ default: [] }),
      "is an array of other than unchecked String",
    ],
    [
      "a tuple",
      Schema.Tuple([Schema.String]).annotate({ default: ["a"] }),
      "has the JSON Schema constraint prefixItems",
    ],
    [
      "a nested struct",
      Schema.Struct({ a: Schema.Boolean }).annotate({ default: { a: true } }),
      "isn't a Boolean, a String, Literals of strings, a Number or an integer, or an Array of String",
    ],
    [
      "a transformation",
      Schema.NumberFromString.annotate({ default: 1 } as never),
      "transforms its value, which the store holds as it is",
    ],
    [
      "an optional field",
      Schema.optionalKey(Schema.Boolean.annotate({ default: true })),
      "is optional, but a setting always has a value",
    ],
    ["a summary that isn't text", Schema.Boolean.annotate({ default: true, title: "\0" }), 'has the title "\\u0000"'],
  ])("a field with %s", (_, field, reason) => {
    const error = refusal(Schema.Struct({ field }));

    expect(error.key).toBe("field");
    expect(error.reason).toContain(reason);
    expect(error.message).toBe(`the setting "field" ${error.reason}`);
  });

  test("settings that aren't a struct", () => {
    expect(refusal("flag").message).toBe("the settings aren't a Schema.Struct");
    expect(refusal(Schema.Boolean).message).toBe("the settings aren't a Schema.Struct");
    expect(refusal(Schema.Record(Schema.String, Schema.Boolean)).message).toBe("the settings aren't a Schema.Struct");
    expect(refusal(Schema.Struct({}).check(Schema.makeFilter(() => true))).message).toBe(
      "the settings aren't a Schema.Struct without checks or index signatures",
    );
  });
});

const Settings = Schema.Struct({
  vowelPoints: Schema.Boolean.annotate({ default: true }),
  scheme: Schema.Literals(["academic", "simple"]).annotate({ default: "academic" }),
  words: Schema.Array(Schema.String).annotate({ default: [] }),
});

describe("context.settings", () => {
  test("hands back the host's values by setting name", () => {
    const seen: unknown[] = [];
    const host = recordingHost(
      engine(Settings, (context) => {
        seen.push(context.settings.get("vowelPoints"), context.settings.get("scheme"));
        return {};
      }),
    );
    host.values.set("scheme", "simple");
    host.open();

    expect(seen).toEqual([true, "simple"]);
  });

  test("writes the host's value by GSettings key", () => {
    const host = recordingHost(
      engine(Settings, (context) => ({
        focusIn: () => context.settings.set("vowelPoints", false),
      })),
    );
    const { session } = host.open();
    host.serve(() => session.focusIn!());

    expect(host.written).toEqual([["vowel-points", false]]);
    expect(host.values.get("vowel-points")).toBe(false);
  });

  test("refuses, with an Error, a name the engine doesn't declare", () => {
    const host = recordingHost(
      engine(Settings, (context) => {
        expect(() => (context.settings.get as (key: string) => unknown)("vowel-points")).toThrow(
          new Error('the engine declares no setting "vowel-points"'),
        );
        return {};
      }),
    );
    host.open();
  });

  test("calls onChange once the store holds a change from the page, in each session", () => {
    const seen: unknown[] = [];
    const host = recordingHost(
      engine(Settings, (context) => {
        context.settings.onChange("scheme", (value) => seen.push([value, context.settings.get("scheme")]));
        return {};
      }),
    );
    host.open();
    host.open();
    host.change("scheme", "simple");

    expect(seen).toEqual([
      ["simple", "simple"],
      ["simple", "simple"],
    ]);
  });

  test("calls onChange for the session's own write once its call has returned, in every session", () => {
    const seen: unknown[] = [];
    let writing = false;
    const host = recordingHost(
      engine(Settings, (context) => {
        context.settings.onChange("words", (value) => seen.push([writing, value]));
        return {
          focusIn() {
            writing = true;
            context.settings.set("words", ["x"]);
            writing = false;
          },
        };
      }),
    );
    const { session } = host.open();
    host.open();
    host.serve(() => session.focusIn!());

    expect(seen).toEqual([
      [false, ["x"]],
      [false, ["x"]],
    ]);
  });

  test("calls only the changed setting's subscribers, each subscription once, in subscription order", () => {
    const seen: string[] = [];
    const host = recordingHost(
      engine(Settings, (context) => {
        const twice = () => seen.push("twice");
        context.settings.onChange("vowelPoints", () => seen.push("first"));
        context.settings.onChange("vowelPoints", twice);
        context.settings.onChange("vowelPoints", twice);
        context.settings.onChange("scheme", () => seen.push("scheme"));
        return {};
      }),
    );
    host.open();
    host.change("vowel-points", false);

    expect(seen).toEqual(["first", "twice", "twice"]);
  });

  test("stops calling a subscriber once it unsubscribes, even from inside a change", () => {
    const seen: string[] = [];
    const host = recordingHost(
      engine(Settings, (context) => {
        const stop = context.settings.onChange("vowelPoints", (value) => {
          seen.push(`first ${value}`);
          stop();
          stopSecond();
        });
        const stopSecond = context.settings.onChange("vowelPoints", (value) => seen.push(`second ${value}`));
        return {};
      }),
    );
    host.open();
    host.change("vowel-points", false);
    host.change("vowel-points", true);

    expect(seen).toEqual(["first false", "second false"]);
  });

  test("hides the host's settingChanged from the session's own", () => {
    const seen: unknown[] = [];
    const host = recordingHost(engine(Settings, () => ({ settingChanged: (key: string) => seen.push(key) })));
    host.open();
    host.change("scheme", "simple");

    expect(seen).toEqual([]);
  });
});

describe("the session the host gets", () => {
  test("calls the session's handlers with the session as this, reading each when called", () => {
    const seen: unknown[] = [];
    const created = {
      processKey(this: unknown, keyval: number) {
        seen.push(this === created, keyval);
        return true;
      },
    } as { processKey(keyval: number): boolean; focusIn?: () => void };
    const host = recordingHost(engine(Settings, () => created));
    const { session } = host.open();

    expect(session.processKey!(0x61, 30, 0, "a")).toBe(true);
    created.focusIn = () => seen.push("focusIn");
    session.focusIn!();

    expect(seen).toEqual([true, 0x61, "focusIn"]);
  });

  test("runs a handler's Effect and hands the host its value", () => {
    const host = recordingHost(
      engine(Settings, (context) => ({
        processKey: (keyval: number) =>
          Effect.sync(() => {
            context.commit(String(keyval));
            return true;
          }),
        focusIn: () => Effect.sync(() => context.commit("in")),
      })),
    );
    const { session, calls } = host.open();

    expect(session.processKey!(0x61, 30, 0, "a")).toBe(true);
    session.focusIn!();
    expect(calls).toEqual([
      { method: "commit", args: ["97"] },
      { method: "commit", args: ["in"] },
    ]);
  });

  test("throws, for the host to report as a fault, a handler's Effect that fails or goes asynchronous", () => {
    const { session } = recordingHost(
      engine(Settings, () => ({
        processKey: () => Effect.promise(() => Promise.resolve(true)),
        focusIn: () => Effect.sleep("1 millis"),
        reset: () => Effect.fail(new Error("no reset")),
      })),
    ).open();

    expect(() => session.processKey!(0x61, 30, 0, "a")).toThrow(
      "An asynchronous Effect was executed with Effect.runSync",
    );
    expect(() => session.focusIn!()).toThrow("An asynchronous Effect was executed with Effect.runSync");
    expect(() => session.reset!()).toThrow("no reset");
  });

  test("interrupts a handler's Effect that goes asynchronous, so the rest of it never runs", async () => {
    const { session, calls } = recordingHost(
      engine(Settings, (context) => ({
        focusIn: () =>
          Effect.promise(() => Promise.resolve()).pipe(Effect.andThen(Effect.sync(() => context.commit("late")))),
        focusOut: () => Effect.sleep("1 millis").pipe(Effect.andThen(Effect.sync(() => context.commit("later")))),
      })),
    ).open();

    expect(() => session.focusIn!()).toThrow("An asynchronous Effect was executed with Effect.runSync");
    expect(() => session.focusOut!()).toThrow("An asynchronous Effect was executed with Effect.runSync");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toEqual([]);
  });

  test("consumes no key for a session without processKey", () => {
    const { session } = recordingHost(engine(Settings)).open();

    expect(session.processKey!(0x61, 30, 0, "a")).toBe(false);
  });

  test("is what create returned when that isn't a session, for the host to refuse", () => {
    const defined = defineEngine({ displayName: "T", languages: [], create: () => null as never });

    expect(recordingHost(defined).open().session).toBeNull();
  });
});
