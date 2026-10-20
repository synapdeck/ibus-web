// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { MODULE_ABI, type EngineContext as ContractContext } from "@ibus-web/protocol/module-script";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { defineEngine, defineModule, ModuleDefinitionError, type ModuleDefinition } from "../src/index.ts";

const flag = Schema.Boolean.annotate({ default: true });

const engine = (settings?: Schema.Struct.Fields) =>
  defineEngine({
    displayName: "Test",
    languages: ["he"],
    ...(settings === undefined ? {} : { settings: Schema.Struct(settings) }),
    create: () => ({}),
  });

const module = (overrides: Partial<ModuleDefinition<Record<string, ReturnType<typeof engine>>>> = {}) =>
  defineModule({
    name: "test",
    version: "1.0.0",
    license: "MIT",
    settingsPrefix: "org.example.test",
    engines: { test: engine({ flag }) },
    ...overrides,
  });

// The error define throws, which must not be a TypeError: the host reads one
// thrown during import as a failed fetch.
const refusal = (define: () => unknown): ModuleDefinitionError => {
  try {
    define();
  } catch (error) {
    expect(error).toBeInstanceOf(ModuleDefinitionError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as ModuleDefinitionError)._tag).toBe("ModuleDefinitionError");
    return error as ModuleDefinitionError;
  }
  throw new Error("defined without a refusal");
};

describe("defineEngine", () => {
  test("defaults the keyboard to the page's layout with no keys passed through", () => {
    expect(engine().descriptor).toEqual({
      displayName: "Test",
      languages: ["he"],
      keyboard: { layout: "default", passThrough: [] },
    });
  });

  test("defaults each part of the keyboard the descriptor leaves out", () => {
    const create = () => ({});

    expect(defineEngine({ displayName: "T", languages: [], keyboard: { layout: "us" }, create }).descriptor).toEqual({
      displayName: "T",
      languages: [],
      keyboard: { layout: "us", passThrough: [] },
    });
    expect(
      defineEngine({ displayName: "T", languages: [], keyboard: { passThrough: ["Tab"] }, create }).descriptor.keyboard,
    ).toEqual({ layout: "default", passThrough: ["Tab"] });
  });

  test("keeps only the descriptor's fields in the descriptor", () => {
    const defined = defineEngine({
      displayName: "T",
      languages: [],
      settings: Schema.Struct({ flag }),
      create: () => ({}),
    });

    expect(Object.keys(defined.descriptor)).toEqual(["displayName", "languages", "keyboard"]);
    expect(defined.settings).toEqual({ flag: { type: "b", default: true } });
  });

  test.each([
    ["an empty display name", { displayName: "" }, 'at ["displayName"]'],
    ["languages that aren't a list", { languages: "he" }, 'at ["languages"]'],
    ["a layout the manifest doesn't have", { keyboard: { layout: "de" } }, 'at ["keyboard"]["layout"]'],
  ])("refuses a descriptor with %s", (_, descriptor, where) => {
    const error = refusal(() =>
      defineEngine({ displayName: "T", languages: [], ...(descriptor as object), create: () => ({}) }),
    );

    expect(error.engine).toBeUndefined();
    expect(error.key).toBeUndefined();
    expect(error.reason).toMatch(/^the descriptor is one the manifest would refuse: /);
    expect(error.reason).toContain(where);
    expect(error.message).toBe(error.reason);
  });

  test("refuses a descriptor with data, which a JavaScript module's engine can't have", () => {
    const data = ["/nix/store/00000000000000000000000000000000-data"];
    const error = refusal(() => defineEngine({ displayName: "T", languages: [], data, create: () => ({}) } as never));

    expect(error.reason).toBe("the descriptor has data, which a JavaScript module's engine can't have");
  });

  test("refuses a key no engine has, such as a misspelled field", () => {
    const error = refusal(() => defineEngine({ displayName: "T", langauges: [], create: () => ({}) } as never));

    expect(error.reason).toBe('the definition has "langauges", which is no engine key');
    expect(error.engine).toBeUndefined();
  });

  test("accepts every descriptor field, settings and create", () => {
    defineEngine({
      displayName: "T",
      languages: ["he"],
      keyboard: { layout: "us", passThrough: [] },
      settings: Schema.Struct({ flag }),
      create: () => ({}),
    });
  });

  test("has no settings key when it declares none", () => {
    expect(Object.hasOwn(engine(), "settings")).toBe(false);
  });

  test("hands create the host's output calls, with the definition as this, and the host a session calling its own", () => {
    const log = () => {};
    const context = { log, settings: {} } as unknown as ContractContext;
    const seen: unknown[] = [];
    const defined = defineEngine({
      displayName: "T",
      languages: [],
      create(given) {
        seen.push(given.log, this.displayName);
        return { focusIn: () => void seen.push("focusIn") };
      },
    });

    defined.create(context).focusIn!();
    expect(seen).toEqual([log, "T", "focusIn"]);
  });
});

describe("defineModule", () => {
  test("brands the definition with the contract's version and keeps the rest", () => {
    const persist = () => {};
    const defined = module({ persist });

    expect(defined).toEqual({
      ibusWebModule: MODULE_ABI,
      name: "test",
      version: "1.0.0",
      license: "MIT",
      settingsPrefix: "org.example.test",
      engines: { test: expect.objectContaining({ settings: { flag: { type: "b", default: true } } }) },
      persist,
    });
  });

  test("keeps the engines in the order they were written", () => {
    const engines = { zeta: engine(), alpha: engine(), "mid.dle": engine() };

    expect(Object.keys(module({ engines }).engines)).toEqual(["zeta", "alpha", "mid.dle"]);
  });

  test("accepts a module without settings and without a settingsPrefix", () => {
    expect(
      defineModule({ name: "test", version: "1", license: "MIT", engines: { test: engine() } }),
    ).not.toHaveProperty("settingsPrefix");
  });

  test.each(["Hebrew", "1", "he_il", "-he", "he..il", "he.", ".he", "he.2il", "", "xkb:us::eng"])(
    "refuses the engine name %j, which can't end a schema id",
    (name) => {
      const error = refusal(() => module({ engines: { [name]: engine() } }));

      expect(error.engine).toBe(name);
      expect(error.key).toBeUndefined();
      expect(error.reason).toMatch(/^can't end a settings schema id/);
      expect(error.message).toBe(`the engine ${JSON.stringify(name)} ${error.reason}`);
    },
  );

  test("refuses an engine name that can't form a schema id even when the engine has no settings", () => {
    expect(refusal(() => module({ engines: { Test: engine() } })).engine).toBe("Test");
  });

  test.each(["he", "he-il", "he.il", "a1.b-2"])("accepts the engine name %j", (name) => {
    expect(Object.keys(module({ engines: { [name]: engine({ flag }) } }).engines)).toEqual([name]);
  });

  test("refuses settings without a settingsPrefix", () => {
    const error = refusal(() =>
      defineModule({ name: "test", version: "1", license: "MIT", engines: { test: engine({ flag }) } }),
    );

    expect({
      _tag: error._tag,
      engine: error.engine,
      key: error.key,
      reason: error.reason,
      message: error.message,
    }).toEqual({
      _tag: "ModuleDefinitionError",
      engine: "test",
      key: undefined,
      reason: "declares settings, but the module has no settingsPrefix",
      message: 'the engine "test" declares settings, but the module has no settingsPrefix',
    });
  });

  test.each(["", "Org.example", "org..example", "org.example.", "org_example", "org.2example", "org/example"])(
    "refuses the settingsPrefix %j",
    (settingsPrefix) => {
      const error = refusal(() => module({ settingsPrefix }));

      expect(error.engine).toBeUndefined();
      expect(error.reason).toContain(`the settingsPrefix ${JSON.stringify(settingsPrefix)} isn't a schema id`);
      expect(error.message).toBe(error.reason);
    },
  );

  test("refuses a malformed settingsPrefix when no engine has settings", () => {
    expect(refusal(() => module({ settingsPrefix: "Org", engines: { test: engine() } })).reason).toContain(
      'the settingsPrefix "Org"',
    );
  });

  test("refuses a definition whose engines aren't engines", () => {
    expect(refusal(() => module({ engines: undefined as never })).message).toBe("the module has no engines");
    expect(refusal(() => module({ engines: { test: null as never } })).message).toBe(
      'the engine "test" isn\'t an engine',
    );
    expect(refusal(() => module({ engines: { test: { ...engine(), settings: "flag" as never } } })).message).toBe(
      'the engine "test" has settings that aren\'t keys by name',
    );
  });
});
