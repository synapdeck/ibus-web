// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { MODULE_ABI, type ModuleEngine, type ModuleScript } from "@ibus-web/protocol/module-script";
import { namedEngine } from "./engine.ts";
import { ModuleDefinitionError } from "./errors.ts";

/** A module's engines by IBus engine name. */
export type Engines = Readonly<Record<string, ModuleEngine>>;

export interface ModuleDefinition<E extends Engines> {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /** The start of each engine's settings schema id, `<settingsPrefix>.<engine>`. Required when any engine has settings. */
  readonly settingsPrefix?: string;
  /** Engines by IBus engine name; the first is the module's default. */
  readonly engines: E;
  /** Writes what the module keeps in memory to storage, since the page may end the Worker next. */
  persist?(): void;
  /** Releases what the module holds; no request reaches an engine afterwards. */
  shutdown?(): void;
}

/** A module script's default export, its engines typed as they were defined. */
export type Module<E extends Engines> = Omit<ModuleScript, "engines"> & { readonly engines: E };

// Each component of a schema id: what GSettings' ids are made of. A leading
// letter also keeps an engine's name from being an array index, which an
// object would enumerate out of order.
const idPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const idRule = "dot-separated components, each a lowercase letter followed by lowercase letters, digits or -";

const check = (definition: ModuleDefinition<Engines>): void => {
  const { settingsPrefix, engines } = definition;

  if (settingsPrefix !== undefined && (typeof settingsPrefix !== "string" || !idPattern.test(settingsPrefix)))
    throw new ModuleDefinitionError({
      reason: `the settingsPrefix ${JSON.stringify(settingsPrefix)} isn't a schema id: ${idRule}`,
    });
  if (!isObject(engines)) throw new ModuleDefinitionError({ reason: "the module has no engines" });

  for (const [name, engine] of Object.entries(engines)) {
    if (!idPattern.test(name))
      throw new ModuleDefinitionError({ engine: name, reason: `can't end a settings schema id: it must be ${idRule}` });
    if (!isObject(engine)) throw new ModuleDefinitionError({ engine: name, reason: "isn't an engine" });

    const { settings } = engine;
    if (settings === undefined) continue;

    if (!isObject(settings))
      throw new ModuleDefinitionError({ engine: name, reason: "has settings that aren't keys by name" });
    if (settingsPrefix === undefined)
      throw new ModuleDefinitionError({
        engine: name,
        reason: "declares settings, but the module has no settingsPrefix",
      });
  }
};

/**
 * Makes a module script's default export, each engine `defineEngine` made in it a new one that knows its name. Throws
 * a `ModuleDefinitionError` for an engine name or settings prefix GSettings can't hold.
 */
export const defineModule = <E extends Engines>(definition: ModuleDefinition<E>): Module<E> => {
  check(definition);

  const engines = Object.fromEntries(
    Object.entries(definition.engines).map(([name, engine]) => [name, namedEngine(engine, name)]),
  ) as E;

  return { ...definition, engines, ibusWebModule: MODULE_ABI };
};
