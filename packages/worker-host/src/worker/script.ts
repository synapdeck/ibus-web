// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A module script's default export, checked against its manifest at start,
// so that a manifest that doesn't belong to its script fails there rather
// than at a key.

import type { EngineDescriptor, JsModuleManifest } from "@ibus-web/protocol";
import { MODULE_ABI, type ModuleScript } from "@ibus-web/protocol/module-script";
import type { StartupRefusal } from "../shared/messages.ts";
import { StartupFailed } from "./failure.ts";
import { declarationProblem, wellFormed } from "./js-settings.ts";

// What a script's descriptor states, in a fixed order, read without trusting
// its shape.
const descriptorFields = (descriptor: unknown): string => {
  const { displayName, languages, keyboard } = (descriptor ?? {}) as Partial<EngineDescriptor>;
  return JSON.stringify([displayName, languages, keyboard?.layout, keyboard?.passThrough]);
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

// An object enumerates these first, in numeric order, whatever order the
// script wrote them in, so the engines' order can't be read from it.
const isArrayIndex = (name: string): boolean => /^(?:0|[1-9][0-9]*)$/.test(name) && Number(name) < 2 ** 32 - 1;

// Dot-separated components, each one a component of the schemas' paths.
const prefixValid = (prefix: string): boolean => /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(prefix);

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  JSON.stringify(a.toSorted()) === JSON.stringify(b.toSorted());

export const checkScript = (exported: unknown, manifest: JsModuleManifest): ModuleScript => {
  const refuse = (message: string, refused: StartupRefusal = "manifest"): StartupFailed =>
    new StartupFailed({ message: `module script ${manifest.module.url}: ${message}`, refused });

  if (!isObject(exported) || !("ibusWebModule" in exported))
    throw refuse("its default export isn't an ibus-web module");
  const { ibusWebModule, name, engines, settingsPrefix } = exported;
  if (ibusWebModule !== MODULE_ABI)
    throw new StartupFailed({
      message: `ModuleAbiMismatch: script ${String(ibusWebModule)}, host ${MODULE_ABI}`,
      refused: "ModuleAbiMismatch",
    });
  if (name !== manifest.name) throw refuse(`it is the module ${JSON.stringify(name)}, not ${manifest.name}`);
  for (const hook of ["persist", "shutdown"])
    if (exported[hook] !== undefined && typeof exported[hook] !== "function")
      throw refuse(`its ${hook} isn't a function`);
  if (!isObject(engines)) throw refuse("it has no engines");

  const names = Object.keys(engines);
  const indexed = names.find(isArrayIndex);
  if (indexed !== undefined) throw refuse(`its engine ${indexed} is named as an array index, which has no order`);
  const missing = manifest.engines.find(({ name }) => !names.includes(name));
  if (missing !== undefined) throw refuse(`it has no engine ${missing.name}`);
  const extra = names.find((name) => !manifest.engines.some((descriptor) => descriptor.name === name));
  if (extra !== undefined) throw refuse(`its engine ${extra} isn't in the manifest`);
  // The first engine is the module's default.
  if (names.some((name, index) => manifest.engines[index]!.name !== name))
    throw refuse(`its engines are in another order than the manifest's: ${names.join(", ")}`);

  if (settingsPrefix !== undefined && (typeof settingsPrefix !== "string" || !prefixValid(settingsPrefix)))
    throw refuse(`its settingsPrefix ${JSON.stringify(settingsPrefix)} can't start a schema id`);

  const schemaIds: string[] = [];
  for (const descriptor of manifest.engines) {
    const engine = engines[descriptor.name];
    if (!isObject(engine) || typeof engine["create"] !== "function")
      throw refuse(`its engine ${descriptor.name} has no create function`);
    if (descriptorFields(engine["descriptor"]) !== descriptorFields(descriptor))
      throw refuse(`its engine ${descriptor.name}'s descriptor differs from the manifest's`);

    const settings = engine["settings"];
    if (settings === undefined) continue;

    if (!isObject(settings) || Array.isArray(settings))
      throw refuse(`its engine ${descriptor.name}'s settings aren't keys by name`);
    if (settingsPrefix === undefined)
      throw refuse(`its engine ${descriptor.name} declares settings, but the module has no settingsPrefix`);
    for (const [key, declaration] of Object.entries(settings)) {
      if (key === "" || !wellFormed(key))
        throw refuse(
          `its engine ${descriptor.name} has a setting named ${JSON.stringify(key)}, which no record can carry`,
        );
      const problem = declarationProblem(declaration);
      if (problem !== undefined) throw refuse(`its engine ${descriptor.name}'s setting ${key} ${problem}`);
    }
    schemaIds.push(`${settingsPrefix}.${descriptor.name}`);
  }

  // The page reads each engine's settings from the manifest's schemas, so a
  // manifest built from another version of the script would offer others.
  if (!sameIds(schemaIds, manifest.settingsSchemas))
    throw refuse(
      `its settings schemas, ${schemaIds.join(", ") || "none"}, aren't the manifest's, ` +
        `${manifest.settingsSchemas.join(", ") || "none"}`,
    );
  return exported as unknown as ModuleScript;
};
