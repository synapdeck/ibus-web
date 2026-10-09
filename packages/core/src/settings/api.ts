// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Context, Effect, Layer, Schema, type Stream } from "effect";
import {
  decodeSettingsMetadata,
  encodeValue,
  ModuleManifest,
  variant,
  type SettingsMetadata,
  type GVariantVariant,
} from "@ibus-web/protocol";
import { SettingsSource, type SettingsChange, type SettingsInstance } from "../services/settings.ts";
export type SettingsSchema = SettingsMetadata["schemas"][number];
export type SettingsKey = SettingsSchema["keys"][number];
export type SettingValue = typeof GVariantVariant.Type;
export interface SettingsOptions {
  readonly modules: Readonly<Record<string, URL>>;
  readonly loadManifest?: (url: URL, signal?: AbortSignal) => Promise<unknown>;
  readonly loadMetadata?: (url: URL, signal?: AbortSignal) => Promise<unknown>;
}
const fetchJson = async (url: URL, signal?: AbortSignal): Promise<unknown> => {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`Settings fetch failed: ${response.status}`);
  return response.json();
};
export async function loadSettingsMetadata(
  manifest: ModuleManifest,
  url: URL,
  options: Pick<SettingsOptions, "loadMetadata">,
  signal?: AbortSignal,
): Promise<SettingsMetadata> {
  if (!manifest.settingsMetadata) {
    if (manifest.settingsSchemas.length) throw new Error(`Missing settings metadata for ${manifest.name}`);
    return { schemas: [] };
  }
  const metadata = decodeSettingsMetadata(
    await (options.loadMetadata ?? fetchJson)(new URL(manifest.settingsMetadata.url, url), signal),
  );
  for (const id of manifest.settingsSchemas)
    if (!metadata.schemas.some((schema) => schema.id === id)) throw new Error(`Missing settings schema: ${id}`);
  return { schemas: metadata.schemas.filter((schema) => manifest.settingsSchemas.includes(schema.id)) };
}
export function validateSetting(key: SettingsKey, value: SettingValue): Uint8Array {
  if (value._tag !== "v" || value.type !== key.type)
    throw new Error(`Invalid type for setting ${key.name}: expected ${key.type}`);
  const bytes = encodeValue(key.type, value.value);
  if (key.choices) {
    const values = value.value._tag === "a" ? value.value.items : [value.value];
    if (values.some((item) => item._tag !== "s" || !key.choices!.includes(item.value)))
      throw new Error(`Invalid choice for setting ${key.name}`);
  }
  if (key.range) {
    const min = key.range.min,
      max = key.range.max,
      actual = value.value;
    if (
      !("value" in actual) ||
      !("value" in min) ||
      !("value" in max) ||
      (typeof actual.value !== "number" && typeof actual.value !== "bigint") ||
      (typeof min.value !== "number" && typeof min.value !== "bigint") ||
      (typeof max.value !== "number" && typeof max.value !== "bigint") ||
      !(actual.value >= min.value && actual.value <= max.value)
    )
      throw new Error(`Out of range setting ${key.name}`);
  }
  return bytes;
}
export function settingsInstances(metadata: SettingsMetadata): SettingsInstance[] {
  return metadata.schemas.flatMap((schema) => schema.paths.map((path) => ({ schemaId: schema.id, path })));
}
export interface SettingsApiService {
  schemas(module: string): Promise<readonly SettingsSchema[]>;
  get(module: string, path: string, key: string): Promise<SettingValue>;
  set(module: string, path: string, key: string, value: SettingValue): Promise<void>;
  reset(module: string, path: string, key: string): Promise<void>;
  readonly changes: Stream.Stream<SettingsChange>;
}
export class SettingsApi extends Context.Service<SettingsApi, SettingsApiService>()("@ibus-web/core/SettingsApi") {
  static layer(options: SettingsOptions) {
    return Layer.effect(
      SettingsApi,
      Effect.gen(function* () {
        const source = yield* SettingsSource;
        const controller = new AbortController();
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
        const loaded = new Map<string, Promise<readonly SettingsSchema[]>>();
        const alive = () => {
          if (controller.signal.aborted) throw new Error("Settings API closed");
        };
        const schemas = (module: string): Promise<readonly SettingsSchema[]> => {
          try {
            alive();
          } catch (cause) {
            return Promise.reject(cause);
          }
          const existing = loaded.get(module);
          if (existing) return existing;
          const pending = (async () => {
            const url = options.modules[module];
            if (!url) throw new Error(`Unknown module: ${module}`);
            const manifest = Schema.decodeUnknownSync(ModuleManifest, { onExcessProperty: "error" })(
              await (options.loadManifest ?? fetchJson)(url, controller.signal),
            );
            const metadata = await loadSettingsMetadata(manifest, url, options, controller.signal);
            alive();
            await source.register?.(metadata);
            alive();
            return metadata.schemas;
          })();
          loaded.set(module, pending);
          void pending.catch(() => loaded.delete(module));
          return pending;
        };
        const keyFor = async (module: string, path: string, name: string) => {
          const schema = (await schemas(module)).find((schema) => schema.paths.includes(path));
          const key = schema?.keys.find((key) => key.name === name);
          if (!schema || !key) throw new Error(`Unknown setting: ${path}${name}`);
          return { instance: { schemaId: schema.id, path }, key };
        };
        const set = async (module: string, path: string, name: string, value: SettingValue) => {
          const { instance, key } = await keyFor(module, path, name);
          validateSetting(key, value);
          alive();
          const change = { ...instance, key: name, value };
          if (source.write) await source.write(change);
          else source.written(change);
        };
        return {
          schemas,
          set,
          changes: source.changes,
          get: async (module, path, name) => {
            const { instance, key } = await keyFor(module, path, name);
            const stored = source.read
              ? await source.read(instance, name)
              : (await source.snapshot([instance]))[path]?.[name];
            return stored ?? variant(key.type, key.default);
          },
          reset: async (module, path, name) => {
            const { key } = await keyFor(module, path, name);
            await set(module, path, name, variant(key.type, key.default));
          },
        } satisfies SettingsApiService;
      }),
    );
  }
}
