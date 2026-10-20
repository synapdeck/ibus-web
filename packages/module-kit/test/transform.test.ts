// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Modifier } from "@ibus-web/protocol/module-script";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vitest";
import { defineModule, transformEngine, type TransformDefinition } from "../src/index.ts";
import { recordingHost } from "./recording.ts";

const Keys = {
  space: 0x20,
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  KP_Space: 0xff80,
  KP_Tab: 0xff89,
  KP_Enter: 0xff8d,
  Shift_L: 0xffe1,
  Control_L: 0xffe3,
  Caps_Lock: 0xffe5,
  Left: 0xff51,
} as const;

const upper = (input: string) => input.toUpperCase();

const underlined = (text: string) => ({
  text,
  attributes: [{ type: "underline", value: 1, start: 0, end: Array.from(text).length }],
});

// A session of a transform engine, with a helper to press the keys of a string.
const open = (definition: Partial<TransformDefinition<any>> = {}) => {
  const engine = transformEngine({ displayName: "Test", languages: [], transform: upper, ...definition });
  const host = recordingHost(engine);
  const opened = host.open();
  const { session, calls } = opened;

  const key = (keyval: number, character = "", state = 0): boolean => session.processKey!(keyval, 0, state, character);
  const type = (text: string): boolean[] =>
    Array.from(text).map((character) => key(character.codePointAt(0)!, character));

  const named = (method: string) => calls.filter((call) => call.method === method).map((call) => call.args);

  return { ...opened, host, key, type, named, last: (method: string) => named(method).at(-1) };
};

const sigma = (input: string): string => input.replace(/σ(?=\s|$)/g, "ς");

describe("transformEngine", () => {
  test("appends a key in the alphabet and shows the transformed buffer, underlined, in COMMIT mode", () => {
    const { type, last } = open();

    expect(type("ab")).toEqual([true, true]);
    expect(last("preedit")).toEqual([underlined("AB"), 2, true, "commit"]);
  });

  test("counts the preedit's cursor and underline in code points", () => {
    const { type, last } = open({ transform: () => "😀😀" });
    type("a");

    expect(last("preedit")).toEqual([underlined("😀😀"), 2, true, "commit"]);
  });

  test("shows the raw buffer then the notes as auxiliary text, and hides it when the buffer is empty", () => {
    const { type, key, last } = open({ transform: (input: string) => ({ text: upper(input), notes: ["one", "two"] }) });
    type("ab");

    expect(last("auxiliary")).toEqual(["ab\none\ntwo", true]);

    key(Keys.BackSpace);
    key(Keys.BackSpace);
    expect(last("auxiliary")).toEqual(["", false]);
    expect(last("preedit")).toEqual(["", 0, false, "clear"]);
  });

  test("uses the transform's output exactly as it is", () => {
    const text = "é ";
    const { type, key, named } = open({ transform: () => text });
    type("a");
    key(Keys.space, " ");

    expect(named("commit")).toEqual([[text]]);
  });

  test("the default alphabet is every character but whitespace and control characters", () => {
    const { key, type } = open();

    expect(type("aZ7!é漢")).toEqual([true, true, true, true, true, true]);
    expect(key(0xff, "\n")).toBe(false);
    expect(key(0xff, "\u0085")).toBe(false);
    expect(key(0xff, " ")).toBe(false);
  });

  test("a string alphabet narrows the characters, and a key outside it commits and passes through", () => {
    const { key, type, named } = open({ alphabet: "ab" });

    expect(type("ab")).toEqual([true, true]);
    expect(key("c".codePointAt(0)!, "c")).toBe(false);
    expect(named("commit")).toEqual([["AB"]]);
  });

  test("a predicate alphabet narrows the characters", () => {
    const { type } = open({ alphabet: (character: string) => /[0-9]/.test(character) });

    expect(type("1a")).toEqual([true, false]);
  });

  test("Space, Enter and Tab commit the transformed buffer and pass through", () => {
    for (const [keyval, character] of [
      [Keys.space, " "],
      [Keys.Return, "\r"],
      [Keys.Tab, "\t"],
    ] as const) {
      const { type, key, named, last } = open();
      type("ab");

      expect(key(keyval, character)).toBe(false);
      expect(named("commit")).toEqual([["AB"]]);
      expect(last("preedit")).toEqual(["", 0, false, "clear"]);
    }
  });

  test("Space extends the buffer of an alphabet that holds the space, and Enter and Tab still commit", () => {
    // Wylie-like: a space between syllables is a tsheg.
    const syllables: Readonly<Record<string, string>> = { bod: "བོད", skad: "སྐད", " ": "་" };
    const wylie = (input: string) => input.replace(/bod|skad| /g, (match) => syllables[match]!);

    for (const [keyval, character] of [
      [Keys.Return, "\r"],
      [Keys.Tab, "\t"],
    ] as const) {
      const { type, key, named, last } = open({ alphabet: "abdkos ", transform: wylie });

      expect(type("bod skad")).toEqual(Array(8).fill(true));
      expect(last("preedit")).toEqual([underlined("བོད་སྐད"), 7, true, "commit"]);
      expect(key(keyval, character)).toBe(false);
      expect(named("commit")).toEqual([["བོད་སྐད"]]);
    }

    const keypad = open({ alphabet: (character: string) => /[a-z ]/.test(character), transform: wylie });
    keypad.type("bod");
    expect(keypad.key(Keys.KP_Space, " ")).toBe(true);
    expect(keypad.last("auxiliary")).toEqual(["bod ", true]);
  });

  test("Space on an empty buffer passes through even when the alphabet holds the space", () => {
    const { key, type, named, last } = open({ alphabet: "ab ", transform: (input: string) => input });

    expect(key(Keys.space, " ")).toBe(false);
    expect(named("preedit")).toEqual([]);

    type("a");
    key(Keys.BackSpace);
    expect(key(Keys.space, " ")).toBe(false);
    expect(last("preedit")).toEqual(["", 0, false, "clear"]);

    type("a");
    expect(key(Keys.space, " ")).toBe(true);
    expect(last("auxiliary")).toEqual(["a ", true]);
  });

  test("keypad Space, Enter and Tab act like their main keys", () => {
    for (const keyval of [Keys.KP_Space, Keys.KP_Enter, Keys.KP_Tab]) {
      const { type, key, named } = open();
      type("ab");

      expect(key(keyval)).toBe(false);
      expect(named("commit")).toEqual([["AB"]]);
    }
  });

  test("a key outside the alphabet commits the buffer and passes through, and with nothing pending commits nothing", () => {
    const { type, key, named } = open();

    expect(key(Keys.Left)).toBe(false);
    type("a");
    expect(key(Keys.Left)).toBe(false);
    expect(named("commit")).toEqual([["A"]]);
  });

  test("Backspace deletes the last raw code point, or passes through when the buffer is empty", () => {
    const { type, key, last } = open();

    expect(key(Keys.BackSpace)).toBe(false);
    type("a😀");
    expect(key(Keys.BackSpace)).toBe(true);
    expect(last("preedit")).toEqual([underlined("A"), 1, true, "commit"]);
    expect(last("auxiliary")).toEqual(["a", true]);
  });

  test("Escape commits the raw buffer and is consumed, or passes through when nothing is pending", () => {
    const { type, key, named, last } = open();

    expect(key(Keys.Escape)).toBe(false);
    type("ab");
    expect(key(Keys.Escape)).toBe(true);
    expect(named("commit")).toEqual([["ab"]]);
    expect(last("preedit")).toEqual(["", 0, false, "clear"]);
    expect(key(Keys.Escape)).toBe(false);
  });

  test("a key held with Control, Alt or Super commits the transformed buffer and passes through", () => {
    for (const state of [Modifier.CONTROL, Modifier.MOD1, Modifier.SUPER]) {
      const { type, key, named } = open();
      type("ab");

      expect(key("c".codePointAt(0)!, "c", state)).toBe(false);
      expect(named("commit")).toEqual([["AB"]]);
    }
  });

  test("modifier keys alone and releases change nothing and pass through", () => {
    const { type, key, calls } = open();
    type("ab");
    const before = calls.length;

    for (const keyval of [Keys.Shift_L, Keys.Control_L, Keys.Caps_Lock]) {
      expect(key(keyval)).toBe(false);
      expect(key(keyval, "", Modifier.RELEASE)).toBe(false);
    }
    expect(key("c".codePointAt(0)!, "c", Modifier.RELEASE)).toBe(false);
    expect(key(Keys.space, " ", Modifier.RELEASE)).toBe(false);

    expect(calls.length).toBe(before);
    type("c");
    key(Keys.space, " ");
    expect(calls.filter((call) => call.method === "commit").map((call) => call.args)).toEqual([["ABC"]]);
  });

  test("FocusOut clears the buffer without committing it", () => {
    const { type, key, session, named } = open();
    type("ab");
    session.focusOut!();
    type("c");
    key(Keys.space, " ");

    expect(named("commit")).toEqual([["C"]]);
  });

  test("Reset clears the buffer and hides the preedit", () => {
    const { type, key, session, named, last } = open();
    type("ab");
    session.reset!();

    expect(last("preedit")).toEqual(["", 0, false, "clear"]);
    expect(last("auxiliary")).toEqual(["", false]);
    expect(key(Keys.space, " ")).toBe(false);
    expect(named("commit")).toEqual([]);
  });

  test("a settings change redraws the pending preedit with the new values, and does nothing without one", () => {
    const settings = Schema.Struct({ shout: Schema.Boolean.annotate({ default: false }) });
    const { host, type, calls, last } = open({
      settings,
      transform: (input: string, values: { shout: boolean }) => (values.shout ? upper(input) : input),
    });

    host.change("shout", true);
    host.change("shout", false);
    expect(calls).toEqual([]);

    type("ab");
    expect(last("preedit")).toEqual([underlined("ab"), 2, true, "commit"]);

    host.change("shout", true);
    expect(last("preedit")).toEqual([underlined("AB"), 2, true, "commit"]);
  });

  test("a transform that throws on some prefixes shows the raw buffer meanwhile, warns once, and commits the whole word", () => {
    const { type, key, named, last } = open({
      transform: (input: string) => {
        if (input === "ax") throw new Error("no ax");
        return upper(input);
      },
    });

    expect(type("a")).toEqual([true]);
    expect(last("preedit")).toEqual([underlined("A"), 1, true, "commit"]);

    expect(type("x")).toEqual([true]);
    expect(last("preedit")).toEqual([underlined("ax"), 2, true, "commit"]);
    expect(last("auxiliary")).toEqual(["ax", true]);
    expect(named("log")).toEqual([["warning", expect.stringContaining("no ax")]]);
    expect(named("commit")).toEqual([]);

    type("y");
    expect(last("preedit")).toEqual([underlined("AXY"), 3, true, "commit"]);

    expect(key(Keys.space, " ")).toBe(false);
    expect(named("commit")).toEqual([["AXY"]]);
    expect(named("log")).toHaveLength(1);
  });

  test("a transform that throws on the whole word commits the raw buffer at each ending key", () => {
    for (const end of [
      () => ({ keyval: Keys.space, character: " ", state: 0 }),
      () => ({ keyval: Keys.Return, character: "\r", state: 0 }),
      () => ({ keyval: Keys.Tab, character: "\t", state: 0 }),
      () => ({ keyval: 0x31, character: "1", state: 0 }),
      () => ({ keyval: 0x63, character: "c", state: Modifier.CONTROL }),
    ]) {
      const { type, key, named, last } = open({
        alphabet: (character: string) => /[a-z]/.test(character),
        transform: (input: string): string => {
          if (input.startsWith("b")) throw new Error("no b");
          return upper(input);
        },
      });
      const { keyval, character, state } = end();

      type("bc");
      expect(last("preedit")).toEqual([underlined("bc"), 2, true, "commit"]);
      expect(key(keyval, character, state)).toBe(false);
      expect(named("commit")).toEqual([["bc"]]);
      expect(named("log")).toHaveLength(1);
      expect(last("preedit")).toEqual(["", 0, false, "clear"]);

      // The engine keeps running, and a new word warns again.
      type("bd");
      key(Keys.Return, "\r");
      type("a");
      key(Keys.Return, "\r");
      expect(named("commit")).toEqual([["bc"], ["bd"], ["A"]]);
      expect(named("log")).toHaveLength(2);
    }
  });

  test("a word that throws warns again after Backspace empties the buffer", () => {
    const { type, key, named } = open({
      transform: () => {
        throw new Error("always");
      },
    });
    type("a");
    key(Keys.BackSpace);
    type("a");

    expect(named("log")).toHaveLength(2);
  });

  test.each([
    ["text holding a NUL", () => "a\0b", "holds a NUL or a lone surrogate"],
    ["text holding a lone surrogate", () => "😀".slice(0, 1), "holds a NUL or a lone surrogate"],
    ["a note holding a lone surrogate", () => ({ text: "a", notes: ["\udc00"] }), "notes aren't a list of text"],
    ["notes that aren't a list", () => ({ text: "a", notes: "n" }), "notes aren't a list of text"],
    ["text that isn't a string", () => ({ text: 5 }), "neither text nor { text, notes? }"],
    ["nothing", () => undefined, "neither text nor { text, notes? }"],
  ])("a transform that returns %s is a transform that threw", (_, transform, reason) => {
    const { type, key, named, last } = open({ transform: transform as () => string });

    expect(type("ab")).toEqual([true, true]);
    expect(last("preedit")).toEqual([underlined("ab"), 2, true, "commit"]);
    expect(named("commit")).toEqual([]);
    expect(named("log")).toEqual([["warning", expect.stringContaining(reason)]]);
    expect(key(Keys.space, " ")).toBe(false);
    expect(named("commit")).toEqual([["ab"]]);
  });

  test("a transform that throws when the buffer is committed commits the raw buffer and passes the key through", () => {
    let fail = false;
    const { type, key, named } = open({
      transform: (input: string) => {
        if (fail) throw new Error("late");
        return upper(input);
      },
    });
    type("ab");
    fail = true;

    expect(key(Keys.space, " ")).toBe(false);
    expect(named("commit")).toEqual([["ab"]]);
    expect(named("log")).toHaveLength(1);
  });

  test("runs an Effect a transform returns, of either shape", () => {
    const text = open({ transform: (input: string) => Effect.succeed(upper(input)) });
    text.type("a");
    expect(text.last("preedit")).toEqual([underlined("A"), 1, true, "commit"]);

    const record = open({ transform: (input: string) => Effect.succeed({ text: upper(input), notes: ["n"] }) });
    record.type("a");
    expect(record.last("auxiliary")).toEqual(["a\nn", true]);
  });

  test("a failing Effect is a transform that threw", () => {
    const { type, key, named } = open({ transform: () => Effect.fail("bad") });
    type("a");
    key(Keys.space, " ");

    expect(named("commit")).toEqual([["a"]]);
    expect(named("log")).toHaveLength(1);
  });

  test("a transform whose Effect goes asynchronous is a transform that threw, and the rest of the Effect never runs", async () => {
    let resumed = false;
    const { type, key, named } = open({
      transform: (input: string) =>
        Effect.promise(() => Promise.resolve()).pipe(
          Effect.map(() => {
            resumed = true;
            return input;
          }),
        ),
    });
    type("a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    key(Keys.space, " ");

    expect(named("commit")).toEqual([["a"]]);
    expect(named("log")).toEqual([["warning", expect.stringContaining("asynchronous")]]);
    expect(resumed).toBe(false);
  });

  test("re-transforms the whole buffer on every key, so a final form follows its context", () => {
    const { type, key, named, last } = open({ transform: sigma });
    type("λόγοσ");
    expect(last("preedit")![0]).toEqual(underlined("λόγος"));

    type("α");
    expect(last("preedit")![0]).toEqual(underlined("λόγοσα"));

    key(Keys.BackSpace);
    expect(last("preedit")![0]).toEqual(underlined("λόγος"));

    key(Keys.space, " ");
    expect(named("commit")).toEqual([["λόγος"]]);
  });

  test("commits a word that goes on after a sigma with the sigma unchanged", () => {
    const { type, key, named } = open({ transform: sigma });
    type("σσσ");
    key(Keys.space, " ");

    expect(named("commit")).toEqual([["σσς"]]);
  });

  test("builds an engine that goes in a module", () => {
    const module = defineModule({
      name: "t",
      version: "1.0.0",
      license: "MIT",
      engines: { test: transformEngine({ displayName: "Test", languages: [], transform: upper }) },
    });

    expect(Object.keys(module.engines)).toEqual(["test"]);
  });
});
