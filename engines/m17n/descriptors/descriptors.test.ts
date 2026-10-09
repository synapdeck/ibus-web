// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "vitest";
import {
  displayName,
  engineDescriptor,
  generate,
  gschema,
  header,
  instances,
  type RawEngine,
  type RawVariable,
  settingsPath,
  sortEngines,
  variableKey,
  variableSchema,
} from "./descriptors.ts";

const engine = (name: string, overrides: Partial<RawEngine> = {}): RawEngine => {
  const [, language, inputMethod] = name.split(":");
  return {
    name,
    language: language!,
    inputMethod: inputMethod!,
    rank: 0,
    layout: "default",
    variables: [],
    ...overrides,
  };
};

const variable = (overrides: Partial<RawVariable> = {}): RawVariable => ({
  name: "level",
  description: "Acceptance level\nThe level of character sequence acceptance.",
  type: "integer",
  value: 1,
  valid: [0, 1, 2],
  ...overrides,
});

const telex = engine("m17n:vi:telex", {
  variables: [
    variable({ name: "tone-mark-on-last", description: "Tone mark position.", value: 0, valid: [0, 1] }),
    variable({ name: "backspace-is-undo", description: null, value: 0, valid: [1, 0] }),
  ],
});
const unicode = engine("m17n:t:unicode", {
  variables: [variable({ name: "prompt", description: "Preedit prompt", type: "text", value: "U+'s", valid: [] })],
});

describe("display names", () => {
  test("name the language in English and the input method in parentheses", () => {
    expect(displayName(engine("m17n:hi:inscript"))).toBe("Hindi (inscript)");
    expect(displayName(engine("m17n:zh:cangjie"))).toBe("Chinese (cangjie)");
  });

  test("use ISO 639's names for the codes ICU doesn't name", () => {
    expect(displayName(engine("m17n:ath:phonetic"))).toBe("Athapascan (phonetic)");
    expect(displayName(engine("m17n:tai:sonla-kbd"))).toBe("Tai (sonla-kbd)");
  });

  test("are the bare input method for the general methods", () => {
    expect(displayName(engine("m17n:t:latn-post"))).toBe("latn-post");
  });

  test("fail for a language nothing names", () => {
    expect(() => displayName(engine("m17n:xqq:kbd"))).toThrow("no English name for language xqq");
  });
});

describe("settings paths", () => {
  test("are ibus-m17n's, from the lowercased names", () => {
    expect(settingsPath(engine("m17n:hi:inscript"))).toBe("/org/freedesktop/ibus/engine/m17n/hi/inscript/");
    expect(settingsPath(engine("m17n:sa:IAST-vedic"))).toBe("/org/freedesktop/ibus/engine/m17n/sa/iast-vedic/");
  });

  test("keep an all-uppercase input method's case", () => {
    expect(settingsPath(engine("m17n:sa:IAST"))).toBe("/org/freedesktop/ibus/engine/m17n/sa/IAST/");
  });
});

describe("engines", () => {
  test("put the default first, then sort by language and input method", () => {
    const raw = ["m17n:zh:cangjie", "m17n:hi:itrans", "m17n:t:latn-post", "m17n:hi:inscript", "m17n:am:sera"].map(
      (name) => engine(name),
    );
    expect(sortEngines(raw, "m17n:t:latn-post").map((entry) => entry.name)).toEqual([
      "m17n:t:latn-post",
      "m17n:am:sera",
      "m17n:hi:inscript",
      "m17n:hi:itrans",
      "m17n:zh:cangjie",
    ]);
  });

  test("fail without the default", () => {
    expect(() => sortEngines([engine("m17n:hi:inscript")], "m17n:t:latn-post")).toThrow("m17n:t:latn-post");
  });

  test("describe each engine on the default keyboard", () => {
    expect(engineDescriptor(engine("m17n:hi:inscript", { layout: "default[lv3:ralt_switch]" }))).toEqual({
      name: "m17n:hi:inscript",
      displayName: "Hindi (inscript)",
      languages: ["hi"],
      keyboard: { layout: "default", passThrough: [] },
    });
    expect(engineDescriptor(engine("m17n:t:latn-post")).languages).toEqual([]);
    expect(() => engineDescriptor(engine("m17n:hi:inscript", { layout: "us" }))).toThrow("unexpected layout us");
  });
});

describe("variable keys", () => {
  test("give an integer variable's values as a range", () => {
    expect(variableKey(variable(), telex)).toEqual({
      name: "level",
      type: "integer",
      default: 1,
      description: "Acceptance level\nThe level of character sequence acceptance.",
      range: { min: 0, max: 2 },
    });
    expect(variableKey(variable({ valid: [1, 0] }), telex).range).toEqual({ min: 0, max: 1 });
    expect(variableKey(variable({ valid: [{ min: 1, max: 9 }] }), telex).range).toEqual({ min: 1, max: 9 });
    expect(variableKey(variable({ valid: [] }), telex).range).toBeUndefined();
  });

  test("give a symbol variable's values as choices", () => {
    const key = variableKey(variable({ type: "symbol", value: "on", valid: ["on", "off"] }), telex);
    expect(key.choices).toEqual(["on", "off"]);
  });

  test("leave a text variable unconstrained", () => {
    expect(variableKey(unicode.variables[0]!, unicode)).toEqual({
      name: "prompt",
      type: "text",
      default: "U+'s",
      description: "Preedit prompt",
    });
  });

  test.each([
    [variable({ name: "Level" }), "isn't a valid GSettings key name"],
    [variable({ name: "a--b" }), "isn't a valid GSettings key name"],
    [variable({ name: "level-" }), "isn't a valid GSettings key name"],
    [variable({ type: null, value: null }), "has no initial value"],
    [variable({ valid: [0, 2] }), "aren't a range"],
    [variable({ valid: [0, { min: 1, max: 2 }] }), "mixes ranges and values"],
    [variable({ value: 5 }), "out of its range"],
    [variable({ type: "symbol", value: "maybe", valid: ["on", "off"] }), "isn't one of its values"],
  ])("refuse %j", (raw, message) => {
    expect(() => variableKey(raw, telex)).toThrow(message);
  });
});

describe("variable schemas", () => {
  test("live under the engine's settings path", () => {
    expect(variableSchema(telex)).toMatchObject({
      id: "org.freedesktop.ibus.engine.m17n.vi.telex",
      path: "/org/freedesktop/ibus/engine/m17n/vi/telex/variables/",
      language: "vi",
      inputMethod: "telex",
    });
  });

  test("are written as GSettings schema XML", () => {
    expect(gschema([variableSchema(telex), variableSchema(unicode)])).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<schemalist>",
        '  <schema id="org.freedesktop.ibus.engine.m17n.vi.telex" path="/org/freedesktop/ibus/engine/m17n/vi/telex/variables/">',
        '    <key name="tone-mark-on-last" type="i">',
        '      <range min="0" max="1"/>',
        "      <default>0</default>",
        "      <description>Tone mark position.</description>",
        "    </key>",
        '    <key name="backspace-is-undo" type="i">',
        '      <range min="0" max="1"/>',
        "      <default>0</default>",
        "    </key>",
        "  </schema>",
        '  <schema id="org.freedesktop.ibus.engine.m17n.t.unicode" path="/org/freedesktop/ibus/engine/m17n/t/unicode/variables/">',
        '    <key name="prompt" type="s">',
        "      <default>'U+\\'s'</default>",
        "      <description>Preedit prompt</description>",
        "    </key>",
        "  </schema>",
        "</schemalist>",
        "",
      ].join("\n"),
    );
  });

  test("are listed for variables.c with each variable's type", () => {
    expect(header([variableSchema(telex), variableSchema(unicode)])).toBe(
      [
        "#define IBUSWEB_M17N_VARIABLES(X) \\",
        '  X("vi", "telex", "org.freedesktop.ibus.engine.m17n.vi.telex", "tone-mark-on-last", INTEGER) \\',
        '  X("vi", "telex", "org.freedesktop.ibus.engine.m17n.vi.telex", "backspace-is-undo", INTEGER) \\',
        '  X("t", "unicode", "org.freedesktop.ibus.engine.m17n.t.unicode", "prompt", TEXT)',
        "",
      ].join("\n"),
    );
  });
});

describe("outputs", () => {
  const raw = [engine("m17n:hi:inscript"), telex, engine("m17n:t:latn-post"), unicode];
  const outputs = generate(raw, "m17n:t:latn-post");

  test("list every engine's settings path for the relocatable schema", () => {
    expect(outputs.settingsPaths).toEqual({
      "org.freedesktop.ibus.engine.m17n": [
        "/org/freedesktop/ibus/engine/m17n/t/latn-post/",
        "/org/freedesktop/ibus/engine/m17n/hi/inscript/",
        "/org/freedesktop/ibus/engine/m17n/t/unicode/",
        "/org/freedesktop/ibus/engine/m17n/vi/telex/",
      ],
    });
  });

  test("list the schemas the module declares, variable schemas by id", () => {
    expect(outputs.settingsSchemas).toEqual([
      "org.freedesktop.ibus.engine.m17n",
      "org.freedesktop.ibus.panel",
      "org.freedesktop.ibus.engine.m17n.t.unicode",
      "org.freedesktop.ibus.engine.m17n.vi.telex",
    ]);
  });

  test("list every instance for test harnesses, as the metadata tool takes them", () => {
    expect(instances(outputs)).toBe(
      [
        "org.freedesktop.ibus.panel",
        "org.freedesktop.ibus.engine.m17n.t.unicode",
        "org.freedesktop.ibus.engine.m17n.vi.telex",
        "org.freedesktop.ibus.engine.m17n=/org/freedesktop/ibus/engine/m17n/t/latn-post/",
        "org.freedesktop.ibus.engine.m17n=/org/freedesktop/ibus/engine/m17n/hi/inscript/",
        "org.freedesktop.ibus.engine.m17n=/org/freedesktop/ibus/engine/m17n/t/unicode/",
        "org.freedesktop.ibus.engine.m17n=/org/freedesktop/ibus/engine/m17n/vi/telex/",
        "",
      ].join("\n"),
    );
  });

  test("fail when two engines share a settings path", () => {
    expect(() => generate([...raw, engine("m17n:hi:Inscript")], "m17n:t:latn-post")).toThrow(
      "two engines share a settings path",
    );
  });
});
