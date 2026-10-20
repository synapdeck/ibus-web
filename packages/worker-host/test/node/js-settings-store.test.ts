// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The JavaScript backend's settings store on its own: each type the contract
// allows, from the page's variants and back, and the values each key
// refuses.

import { booleanVariant, int32Variant, stringVariant, variant, type GVariantValue } from "@ibus-web/protocol";
import type { ModuleScript } from "@ibus-web/protocol/module-script";
import { expect, test } from "vitest";
import { settingsStore } from "../../src/worker/js-settings.ts";

const path = "/org/example/store/kinds/";

const script: ModuleScript = {
  ibusWebModule: 1,
  name: "store",
  version: "1.0.0",
  license: "MIT",
  settingsPrefix: "org.example.store",
  engines: {
    kinds: {
      descriptor: { displayName: "Kinds", languages: [], keyboard: { layout: "us", passThrough: [] } },
      settings: {
        flag: { type: "b", default: false },
        text: { type: "s", default: "" },
        mode: { type: "s", default: "a", choices: ["a", "b"] },
        whole: { type: "i", default: 0 },
        level: { type: "i", default: 1, range: { min: 1, max: 5 } },
        ratio: { type: "d", default: 0.5, range: { min: 0, max: 1 } },
        real: { type: "d", default: 0 },
        list: { type: "as", default: [] },
      },
      create: () => ({}),
    },
  },
};

const strings = (...items: string[]) =>
  variant("as", { _tag: "a", items: items.map((value) => ({ _tag: "s", value })) });
const double = (value: number) => variant("d", { _tag: "d", value });

const storeWith = (values: Record<string, Extract<GVariantValue, { _tag: "v" }>> = {}) => {
  const warnings: string[] = [];
  const store = settingsStore(script, (message) => void warnings.push(message));
  store.init({ settings: [{ schemaId: "org.example.store.kinds", path, values }], patterns: [] });
  return { store, warnings };
};

test("each type reads from Init's variants as a plain value", () => {
  const { store, warnings } = storeWith({
    flag: booleanVariant(true),
    text: stringVariant("𝄞"),
    mode: stringVariant("b"),
    whole: int32Variant(-0x80000000),
    level: int32Variant(5),
    ratio: double(0),
    real: double(-2.25),
    list: strings("x", "y"),
  });
  expect(warnings).toEqual([]);
  expect(Object.keys(script.engines["kinds"]!.settings!).map((key) => store.get("kinds", key))).toEqual([
    true,
    "𝄞",
    "b",
    -0x80000000,
    5,
    0,
    -2.25,
    ["x", "y"],
  ]);
  expect(Object.isFrozen(store.get("kinds", "list"))).toBe(true);
});

test("each type's write is a variant of the key's type, and a change only when the value differs", () => {
  const { store } = storeWith();
  const writes = [
    ["flag", true, booleanVariant(true)],
    ["text", "t", stringVariant("t")],
    ["mode", "b", stringVariant("b")],
    ["whole", 0x7fffffff, int32Variant(0x7fffffff)],
    ["level", 1, int32Variant(1)],
    ["ratio", 1, double(1)],
    ["real", -0, double(-0)],
    ["list", ["p", "q"], strings("p", "q")],
  ] as const;
  for (const [key, value, boxed] of writes)
    expect(store.set("kinds", key, value), key).toEqual({
      path,
      value: boxed,
      change: key === "level" ? undefined : { engine: "kinds", key, value },
    });

  expect(store.set("kinds", "list", ["p", "q"])?.change).toBeUndefined();
  expect(store.set("kinds", "real", 0)?.change).toEqual({ engine: "kinds", key: "real", value: 0 });
});

test("a list's default is a frozen copy of the declaration's", () => {
  const declared = ["a"];
  const store = settingsStore(
    {
      ...script,
      engines: { kinds: { ...script.engines["kinds"]!, settings: { list: { type: "as", default: declared } } } },
    },
    () => {},
  );
  declared.push("b");

  const read = store.get("kinds", "list");
  expect(read).toEqual(["a"]);
  expect(Object.isFrozen(read)).toBe(true);
});

test("a write keeps its own copy of a list", () => {
  const { store } = storeWith();
  const list = ["a"];
  store.set("kinds", "list", list);
  list.push("b");

  expect(store.get("kinds", "list")).toEqual(["a"]);
  expect(Object.isFrozen(store.get("kinds", "list"))).toBe(true);
});

test("a write outside its key's type, choices or range throws, and an undeclared key throws", () => {
  const { store } = storeWith();
  const refused = [
    ["flag", 1],
    ["text", 1],
    ["text", "\uD800"],
    ["text", "a\0b"],
    ["mode", "c"],
    ["whole", 1.5],
    ["whole", 0x80000000],
    ["whole", "1"],
    ["level", 6],
    ["ratio", -0.1],
    ["ratio", Number.NaN],
    ["real", true],
    ["list", "a"],
    ["list", ["a", 1]],
    ["list", ["\0"]],
  ] as const;
  for (const [key, value] of refused)
    expect(() => store.set("kinds", key, value as never), `${key} ${String(value)}`).toThrow(TypeError);

  expect(() => store.get("kinds", "absent")).toThrow("engine kinds has no setting absent");
  expect(() => store.set("kinds", "absent", true)).toThrow("engine kinds has no setting absent");
  expect(() => store.get("other", "flag")).toThrow("engine other has no setting flag");
  expect(store.get("kinds", "level")).toBe(1);
});

test("a variant whose contents don't match its type is refused", () => {
  const { store, warnings } = storeWith({
    flag: variant("b", { _tag: "s", value: "true" }),
    list: variant("as", { _tag: "a", items: [{ _tag: "i", value: 1 }] }),
    whole: variant("i", { _tag: "i", value: 1.5 }),
  });
  expect(warnings).toEqual([
    `Invalid value for settings key: ${path}flag`,
    `Invalid value for settings key: ${path}list`,
    `Invalid value for settings key: ${path}whole`,
  ]);
  expect(store.change(path, "real", int32Variant(1))).toEqual({ _tag: "Invalid" });
  expect(store.change(path, "real", double(3))).toEqual({
    _tag: "Stored",
    change: { engine: "kinds", key: "real", value: 3 },
  });
});
