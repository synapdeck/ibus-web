// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A module script's default export checked against its manifest on its own:
// the hooks, engine names, settings declarations and schema ids a start
// refuses for good.

import type { JsModuleManifest } from "@ibus-web/protocol";
import type { ModuleScript } from "@ibus-web/protocol/module-script";
import { expect, test } from "vitest";
import { StartupFailed } from "../../src/worker/failure.ts";
import { checkScript } from "../../src/worker/script.ts";
import { manifest, scriptUrl } from "./js-host.ts";

const fixture = ((await import(scriptUrl)) as { default: ModuleScript }).default;

// The fixture with its upper engine declaring settings instead of its own.
const upperSettings = (settings: unknown): ModuleScript => ({
  ...fixture,
  engines: { ...fixture.engines, upper: { ...fixture.engines["upper"]!, settings: settings as never } },
});

const refusal = (exported: unknown, against: JsModuleManifest = manifest): unknown => {
  try {
    checkScript(exported, against);
  } catch (error) {
    return error;
  }
  return undefined;
};

test("the fixture script belongs to its manifest", () => {
  expect(checkScript(fixture, manifest)).toBe(fixture);
});

test("a script whose name, hooks, prefix, settings or schemas don't belong is refused for good", () => {
  const [upper, pick, trace, stall] = manifest.engines;
  const indexed: JsModuleManifest = { ...manifest, engines: [{ ...upper!, name: "7" }, pick!, trace!, stall!] };
  const { upper: upperEngine, ...others } = fixture.engines;

  const cases: [string, unknown, RegExp, JsModuleManifest?][] = [
    ["another module's name", { ...fixture, name: "other" }, /: it is the module "other", not js-fixture$/],
    ["a persist that isn't a function", { ...fixture, persist: 1 }, /: its persist isn't a function$/],
    ["a shutdown that isn't a function", { ...fixture, shutdown: "no" }, /: its shutdown isn't a function$/],
    [
      "an engine named as an array index",
      { ...fixture, engines: { 7: upperEngine, ...others } },
      /: its engine 7 is named as an array index, which has no order$/,
      indexed,
    ],
    ["an empty settingsPrefix", { ...fixture, settingsPrefix: "" }, /: its settingsPrefix "" can't start a schema id$/],
    ["a settingsPrefix with an empty component", { ...fixture, settingsPrefix: "org..x" }, /can't start a schema id$/],
    ["settings that aren't an object", upperSettings(null), /: its engine upper's settings aren't keys by name$/],
    ["settings as a list", upperSettings([]), /: its engine upper's settings aren't keys by name$/],
    [
      "a setting with an empty name",
      upperSettings({ "": { type: "b", default: true } }),
      /: its engine upper has a setting named "", which no record can carry$/,
    ],
    [
      "a setting named with a NUL",
      upperSettings({ "a\0b": { type: "b", default: true } }),
      /: its engine upper has a setting named "a\\u0000b", which no record can carry$/,
    ],
    ["a declaration that isn't one", upperSettings({ shout: true }), /setting shout isn't a declaration$/],
    ["an unknown type", upperSettings({ shout: { type: "u", default: 1 } }), /setting shout has the unknown type "u"$/],
    [
      "a default of another type",
      upperSettings({ shout: { type: "b", default: "yes" } }),
      /setting shout has the default "yes", which it doesn't accept$/,
    ],
    [
      "a default outside the range",
      upperSettings({ delay: { type: "d", default: 20, range: { min: 0.1, max: 10 } } }),
      /setting delay has the default 20, which it doesn't accept$/,
    ],
    [
      "a range whose minimum exceeds its maximum",
      upperSettings({ delay: { type: "d", default: 1, range: { min: 10, max: 0.1 } } }),
      /setting delay has the range \{"min":10,"max":0.1\}, which isn't one of its type's$/,
    ],
    [
      "a range of an integer that isn't",
      upperSettings({ count: { type: "i", default: 1, range: { min: 0.5, max: 2 } } }),
      /setting count has the range/,
    ],
    [
      "a range on a boolean",
      upperSettings({ shout: { type: "b", default: true, range: { min: 0, max: 1 } } }),
      /setting shout has the range/,
    ],
    [
      "choices without the default",
      upperSettings({ case: { type: "s", default: "title", choices: ["lower", "upper"] } }),
      /setting case has the default "title", which it doesn't accept$/,
    ],
    [
      "choices on a number",
      upperSettings({ count: { type: "i", default: 1, choices: ["1"] } }),
      /setting count has the choices \["1"\], which aren't strings of its type$/,
    ],
    [
      "a summary that isn't text",
      upperSettings({ shout: { type: "b", default: true, summary: 1 } }),
      /setting shout has a summary or description that isn't text$/,
    ],
    [
      "a schema the manifest lacks",
      fixture,
      /: its settings schemas, org\.example\.jsfixture\.upper, org\.example\.jsfixture\.pick, aren't the manifest's, org\.example\.jsfixture\.upper$/,
      { ...manifest, settingsSchemas: ["org.example.jsfixture.upper"] },
    ],
    [
      "a schema the script lacks",
      { ...fixture, engines: { ...fixture.engines, upper: { ...upperEngine!, settings: undefined } } },
      /: its settings schemas, org\.example\.jsfixture\.pick, aren't the manifest's/,
    ],
  ];

  for (const [what, exported, message, against] of cases) {
    const error = refusal(exported, against);
    expect(error, what).toBeInstanceOf(StartupFailed);
    expect(error, what).toMatchObject({ message: expect.stringMatching(message), refused: "manifest" });
  }
});
