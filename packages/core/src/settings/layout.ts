// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { EngineDescriptor, ModuleManifest, SettingsMetadata } from "@ibus-web/protocol";
import type { SettingsInstance } from "../services/settings.ts";

export type KeyboardLayout = EngineDescriptor["keyboard"]["layout"];

/** The key of the per-engine layout setting. */
export const layoutKey = "layout";

const layouts: readonly KeyboardLayout[] = ["us", "default"];

// A schema's key has one default, and each engine's is the layout it declares, so there is one schema per declared
// layout. Translation happens on the page: the Worker never declares these.
const schemaIds: Readonly<Record<KeyboardLayout, string>> = {
  us: "org.ibus-web.keyboard.us",
  default: "org.ibus-web.keyboard.default",
};

export const isKeyboardLayout = (value: unknown): value is KeyboardLayout => layouts.includes(value as KeyboardLayout);

/**
 * Where an engine's layout setting lives: under the distribution's name, with each of the engine name's `:` parts a
 * path component, or undefined for a name that can't form a canonical path.
 */
export function layoutPath(distribution: string, engine: string): string | undefined {
  const parts = engine.split(":");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("/") || part.includes("\0")))
    return undefined;

  return `/org/ibus-web/keyboard/${distribution}/${parts.join("/")}/`;
}

/** The instance of each engine that has a layout setting, by engine name. */
export function layoutInstances(manifest: ModuleManifest): Map<string, SettingsInstance> {
  const instances = new Map<string, SettingsInstance>();
  const paths = new Set<string>();

  for (const engine of manifest.engines) {
    const path = layoutPath(manifest.name, engine.name);

    // Names that differ only where a path can't tell them apart would share a setting, so neither has one.
    if (path === undefined) continue;
    if (paths.has(path)) {
      for (const [name, instance] of instances) if (instance.path === path) instances.delete(name);
      continue;
    }

    paths.add(path);
    instances.set(engine.name, { schemaId: schemaIds[engine.keyboard.layout], path });
  }

  return instances;
}

/** The layout settings' schemas, holding each engine's instance at its path. */
export function layoutMetadata(manifest: ModuleManifest): SettingsMetadata {
  const instances = [...layoutInstances(manifest).values()];

  return {
    schemas: layouts.flatMap((layout) => {
      const paths = instances.filter((instance) => instance.schemaId === schemaIds[layout]).map(({ path }) => path);
      if (paths.length === 0) return [];

      return [
        {
          id: schemaIds[layout],
          paths,
          keys: [
            {
              name: layoutKey,
              type: "s",
              default: { _tag: "s", value: layout },
              summary: "Keyboard layout",
              description:
                'How keys reach the engine: "us" by their place on a US keyboard, "default" by the character the system layout gives them.',
              choices: [...layouts],
            },
          ],
        },
      ];
    }),
  };
}
