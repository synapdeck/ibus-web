// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { EngineContext, SettingValue } from "@ibus-web/protocol/module-script";
import { describe, expect, test } from "vitest";
import module from "../src/pinyin-tones.module.ts";

const engine = module.engines["pinyin-tones"];

const space = 0x20;

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

// A session with the engine's settings in a map and its output calls recorded.
const open = () => {
  const calls: Call[] = [];
  const values = new Map<string, SettingValue>(
    Object.entries(engine.settings ?? {}).map(([key, declaration]) => [key, declaration.default]),
  );
  const record =
    (method: string) =>
    (...args: unknown[]): void =>
      void calls.push({ method, args });

  const context: EngineContext = {
    commit: record("commit"),
    preedit: record("preedit"),
    auxiliary: record("auxiliary"),
    lookupTable: record("lookupTable"),
    registerProperties: record("registerProperties"),
    updateProperty: record("updateProperty"),
    forwardKey: record("forwardKey"),
    deleteSurrounding: record("deleteSurrounding"),
    requireSurrounding: record("requireSurrounding"),
    settings: {
      get: (key) => values.get(key)!,
      set: (key, value) => void values.set(key, value),
    },
    after: () => () => {},
    log: record("log"),
  };
  const session = engine.create(context);

  const type = (text: string): boolean[] =>
    Array.from(text, (character) => session.processKey!(character.codePointAt(0)!, 0, 0, character));

  const preedit = (): string | undefined => {
    const text = calls.findLast((call) => call.method === "preedit")?.args[0] as { text: string } | string | undefined;
    return typeof text === "object" ? text.text : text;
  };

  return { calls, values, session, type, preedit };
};

describe("the module", () => {
  test("holds one engine of Pinyin with tone numbers", () => {
    expect(Object.keys(module.engines)).toEqual(["pinyin-tones"]);
    expect(engine.descriptor.displayName).toBe("Pinyin (tone numbers)");
  });

  test("names a language that is a well-formed BCP 47 tag", () => {
    expect(engine.descriptor.languages).toEqual(["zh-Latn-pinyin"]);
    expect(Intl.getCanonicalLocales("zh-Latn-pinyin")).toEqual(["zh-Latn-pinyin"]);
  });

  test("declares v-as-u, a titled and described boolean that is on", () => {
    expect(engine.settings).toEqual({
      "v-as-u": { type: "b", default: true, summary: expect.any(String), description: expect.any(String) },
    });
  });
});

describe("the engine", () => {
  test("shows the tone marks of what is typed and commits them on Space", () => {
    const { calls, type, preedit, session } = open();

    type("ni3hao3");
    expect(preedit()).toBe("nǐhǎo");

    // Space commits and then passes through, to be typed after the word.
    expect(session.processKey!(space, 0, 0, " ")).toBe(false);
    expect(calls.findLast((call) => call.method === "commit")?.args).toEqual(["nǐhǎo"]);
  });

  test("reads v as ü while the setting is on, and not after it is turned off", () => {
    const { type, preedit, session, values } = open();

    type("lv4");
    expect(preedit()).toBe("lǜ");

    values.set("v-as-u", false);
    session.settingChanged!("v-as-u", false);
    expect(preedit()).toBe("lv4");
  });

  test("reads keys by what they type, so ü typed on a layout that has it marks", () => {
    const { type, preedit } = open();

    expect(engine.descriptor.keyboard.layout).toBe("default");
    type("lü4");
    expect(preedit()).toBe("lǜ");
  });

  test("registers the setting as a toggle", () => {
    const { calls, session } = open();

    session.focusIn?.();
    const registered = calls.findLast((call) => call.method === "registerProperties")?.args[0] as {
      key: string;
      kind: string;
    }[];
    expect(registered.map(({ key, kind }) => [key, kind])).toEqual([["pinyin-tones:v-as-u", "toggle"]]);
  });

  test("takes letters, ü, the digits 0 to 5, colons and apostrophes, and no other digit", () => {
    const { type } = open();

    expect(type("aZ05:'üÜ")).toEqual([true, true, true, true, true, true, true, true]);
    expect(type("69-")).toEqual([false, false, false]);
  });
});
