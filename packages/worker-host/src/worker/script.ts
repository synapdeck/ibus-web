// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A module script's default export, checked against its manifest at start,
// so that a manifest that doesn't belong to its script fails there rather
// than at a key.

import { scriptProblem, settingsSchemaIds, type EngineDescriptor, type JsModuleManifest } from "@ibus-web/protocol";
import { MODULE_ABI, type ModuleScript } from "@ibus-web/protocol/module-script";
import type { StartupRefusal } from "../shared/messages.ts";
import { StartupFailed } from "./failure.ts";

// What a script's descriptor states, in a fixed order, read without trusting
// its shape.
const descriptorFields = (descriptor: unknown): string => {
  const { displayName, languages, keyboard } = (descriptor ?? {}) as Partial<EngineDescriptor>;
  return JSON.stringify([displayName, languages, keyboard?.layout, keyboard?.passThrough]);
};

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  JSON.stringify(a.toSorted()) === JSON.stringify(b.toSorted());

export const checkScript = (exported: unknown, manifest: JsModuleManifest): ModuleScript => {
  const refuse = (message: string, refused: StartupRefusal = "manifest"): StartupFailed =>
    new StartupFailed({ message: `module script ${manifest.module.url}: ${message}`, refused });

  const problem = scriptProblem(exported);
  if (problem?._tag === "NotAModule") throw refuse("its default export isn't an ibus-web module");
  if (problem?._tag === "ModuleAbiMismatch")
    throw new StartupFailed({
      message: `ModuleAbiMismatch: script ${String(problem.abi)}, host ${MODULE_ABI}`,
      refused: "ModuleAbiMismatch",
    });
  if (problem !== undefined) throw refuse(problem.reason);

  const script = exported as ModuleScript;
  if (script.name !== manifest.name)
    throw refuse(`it is the module ${JSON.stringify(script.name)}, not ${manifest.name}`);

  const names = Object.keys(script.engines);
  const missing = manifest.engines.find(({ name }) => !names.includes(name));
  if (missing !== undefined) throw refuse(`it has no engine ${missing.name}`);
  const extra = names.find((name) => !manifest.engines.some((descriptor) => descriptor.name === name));
  if (extra !== undefined) throw refuse(`its engine ${extra} isn't in the manifest`);
  // The first engine is the module's default.
  if (names.some((name, index) => manifest.engines[index]!.name !== name))
    throw refuse(`its engines are in another order than the manifest's: ${names.join(", ")}`);

  for (const descriptor of manifest.engines)
    if (descriptorFields(script.engines[descriptor.name]!.descriptor) !== descriptorFields(descriptor))
      throw refuse(`its engine ${descriptor.name}'s descriptor differs from the manifest's`);

  // The page reads each engine's settings from the manifest's schemas, so a
  // manifest built from another version of the script would offer others.
  const schemaIds = settingsSchemaIds(script);
  if (!sameIds(schemaIds, manifest.settingsSchemas))
    throw refuse(
      `its settings schemas, ${schemaIds.join(", ") || "none"}, aren't the manifest's, ` +
        `${manifest.settingsSchemas.join(", ") || "none"}`,
    );
  return script;
};
