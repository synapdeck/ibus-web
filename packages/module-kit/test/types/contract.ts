// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Type assertions, checked by tsc and never run: each @ts-expect-error marks
// a line the kit's types must refuse.

import type { EngineDescriptor as ManifestDescriptor } from "@ibus-web/protocol/descriptor";
import type { ModuleScript } from "@ibus-web/protocol/module-script";
import { Effect, Schema } from "effect";
import { defineEngine, defineModule, ModuleDefinitionError, type EngineDescriptor } from "../../src/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const holds = <T extends true>(): T | undefined => undefined;

export const hebrew = defineEngine({
  displayName: "Romanized Hebrew",
  languages: ["he"],
  settings: Schema.Struct({
    vowelPoints: Schema.Boolean.annotate({ default: true, title: "Write vowel points" }),
    scheme: Schema.Literals(["academic", "simple"]).annotate({ default: "academic" }),
    name: Schema.String.annotate({ default: "" }),
    pageSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })).annotate({ default: 10 }),
    words: Schema.Array(Schema.String).annotate({ default: [] }),
  }),
  create(context) {
    const { settings } = context;

    holds<Equal<ReturnType<typeof settings.get<"vowelPoints">>, boolean>>();
    holds<Equal<ReturnType<typeof settings.get<"scheme">>, "academic" | "simple">>();
    holds<Equal<ReturnType<typeof settings.get<"name">>, string>>();
    holds<Equal<ReturnType<typeof settings.get<"pageSize">>, number>>();
    holds<Equal<ReturnType<typeof settings.get<"words">>, readonly string[]>>();

    settings.set("scheme", "simple");
    settings.set("words", ["a"]);
    // @ts-expect-error: a choice holds one of its values.
    settings.set("scheme", "other");
    // @ts-expect-error: a boolean setting holds a boolean.
    settings.set("vowelPoints", "yes");
    // @ts-expect-error: settings are named in camelCase.
    settings.get("vowel-points");
    // @ts-expect-error: the engine declares no such setting.
    settings.set("missing", true);

    const unsubscribe: () => void = settings.onChange("scheme", (value) => {
      holds<Equal<typeof value, "academic" | "simple">>();
    });
    // @ts-expect-error: a subscriber takes the setting's own type.
    settings.onChange("pageSize", (value: string) => value);
    unsubscribe();

    context.preedit("shalom", 6, true, "commit");
    context.after(10, () => context.commit("x"));
    return {
      processKey: (keyval, keycode, state, character) => keyval + keycode + state > 0 && character === "a",
      propertyActivate: (key, checked) => void [key.length, checked satisfies boolean],
      destroy: () => {},
    };
  },
});

export const plain = defineEngine({
  displayName: "Plain",
  languages: [],
  keyboard: { layout: "us" },
  create(context) {
    // @ts-expect-error: an engine without settings has no key to read.
    context.settings.get("anything");
    return {};
  },
});

defineEngine({
  displayName: "Wrong",
  languages: [],
  // @ts-expect-error: a key's answer is whether it was consumed.
  create: () => ({ processKey: () => "yes" }),
});

defineEngine({
  displayName: "Wrong",
  languages: [],
  // @ts-expect-error: the layout is the page's or US.
  keyboard: { layout: "de" },
  create: () => ({}),
});

defineEngine({
  displayName: "Wrong",
  languages: [],
  // @ts-expect-error: a boolean setting's default is a boolean.
  settings: Schema.Struct({ flag: Schema.Boolean.annotate({ default: "yes" }) }),
  create: () => ({}),
});

// The descriptor an author writes is the manifest's, without the name or the
// data, its keyboard and the keyboard's fields optional.
holds<
  Equal<
    EngineDescriptor,
    {
      readonly displayName: string;
      readonly languages: readonly string[];
      readonly keyboard?: {
        readonly layout?: ManifestDescriptor["keyboard"]["layout"];
        readonly passThrough?: readonly string[];
      };
    }
  >
>();

defineEngine({
  displayName: "Wrong",
  languages: [],
  // @ts-expect-error: a JavaScript engine has no data of its own.
  data: [],
  create: () => ({}),
});

export const effects = defineEngine({
  displayName: "Effects",
  languages: [],
  create: (context) => ({
    processKey: () => Effect.succeed(true),
    focusIn: () => Effect.sync(() => context.commit("in")),
    focusOut: () => Effect.fail(new Error("no")),
    reset: () => {},
  }),
});

defineEngine({
  displayName: "Wrong",
  languages: [],
  // @ts-expect-error: an Effect handler's value is the handler's own.
  create: () => ({ processKey: () => Effect.succeed("yes") }),
});

defineEngine({
  displayName: "Wrong",
  languages: [],
  // @ts-expect-error: an Effect handler needs no service, since nothing would provide it.
  create: () => ({ focusIn: () => Effect.void as Effect.Effect<void, never, { readonly service: true }> }),
});

const refused = new ModuleDefinitionError({ engine: "hebrew", key: "vowelPoints", reason: "is wrong" });
holds<Equal<typeof refused._tag, "ModuleDefinitionError">>();
holds<Equal<typeof refused.key, string | undefined>>();
// @ts-expect-error: a refusal states its reason.
void new ModuleDefinitionError({ engine: "hebrew" });

export const module = defineModule({
  name: "test",
  version: "1.0.0",
  license: "MIT",
  settingsPrefix: "org.example.test",
  engines: { hebrew, plain, effects },
  persist: () => {},
}) satisfies ModuleScript;

export const vowelPoints = module.engines.hebrew.settings?.["vowel-points"];
// @ts-expect-error: the contract's declarations are by GSettings key.
void module.engines.hebrew.settings?.vowelPoints;
// @ts-expect-error: the module's engines are typed as they were defined.
void module.engines.greek;

// @ts-expect-error: a module states its license.
defineModule({ name: "test", version: "1", engines: { plain } });

// @ts-expect-error: a property annotation states its label.
Schema.Boolean.annotate({ default: true, property: { symbol: "x" } });
Schema.Boolean.annotate({ default: true, property: { label: "Switch", symbol: "x" } });
