// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Context, Effect, Layer, Schema, type Stream } from "effect";
import {
  decodeSettingsMetadata,
  encodeValue,
  EngineManifest,
  variant,
  type SettingsMetadata,
  type GVariantVariant,
} from "@ibus-web/protocol";
import { SettingsSource, type SettingsChange } from "../services/settings.ts";
export type SettingsSchema = SettingsMetadata["schemas"][number];
export type SettingsKey = SettingsSchema["keys"][number];
export type SettingValue = typeof GVariantVariant.Type;
export interface SettingsOptions {
  readonly engines: Readonly<Record<string, URL>>;
  readonly loadManifest?: (url: URL, signal?: AbortSignal) => Promise<unknown>;
  readonly loadMetadata?: (url: URL, signal?: AbortSignal) => Promise<unknown>;
}
const fetchJson = async (url: URL, signal?: AbortSignal): Promise<unknown> => {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`Settings fetch failed: ${response.status}`);
  return response.json();
};
export async function loadSettingsMetadata(
  manifest: EngineManifest,
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
export interface SettingsApiService {
  schemas(engine: string): Promise<readonly SettingsSchema[]>;
  get(engine: string, schemaId: string, key: string): Promise<SettingValue>;
  set(engine: string, schemaId: string, key: string, value: SettingValue): Promise<void>;
  reset(engine: string, schemaId: string, key: string): Promise<void>;
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
        const schemas = (engine: string): Promise<readonly SettingsSchema[]> => {
          try {
            alive();
          } catch (cause) {
            return Promise.reject(cause);
          }
          const existing = loaded.get(engine);
          if (existing) return existing;
          const pending = (async () => {
            const url = options.engines[engine];
            if (!url) throw new Error(`Unknown engine: ${engine}`);
            const manifest = Schema.decodeUnknownSync(EngineManifest, { onExcessProperty: "error" })(
              await (options.loadManifest ?? fetchJson)(url, controller.signal),
            );
            const metadata = await loadSettingsMetadata(manifest, url, options, controller.signal);
            alive();
            await source.register?.(metadata);
            alive();
            return metadata.schemas;
          })();
          loaded.set(engine, pending);
          void pending.catch(() => loaded.delete(engine));
          return pending;
        };
        const keyFor = async (engine: string, schemaId: string, name: string) => {
          const key = (await schemas(engine))
            .find((schema) => schema.id === schemaId)
            ?.keys.find((key) => key.name === name);
          if (!key) throw new Error(`Unknown setting: ${schemaId}.${name}`);
          return key;
        };
        const set = async (engine: string, schemaId: string, name: string, value: SettingValue) => {
          const key = await keyFor(engine, schemaId, name);
          validateSetting(key, value);
          alive();
          const change = { schemaId, key: name, value };
          if (source.write) await source.write(change);
          else source.written(change);
        };
        return {
          schemas,
          set,
          changes: source.changes,
          get: async (engine, schemaId, name) => {
            const key = await keyFor(engine, schemaId, name);
            const stored = source.read
              ? await source.read(schemaId, name)
              : (await source.snapshot([schemaId]))[schemaId]?.[name];
            return stored ?? variant(key.type, key.default);
          },
          reset: async (engine, schemaId, name) => {
            const key = await keyFor(engine, schemaId, name);
            await set(engine, schemaId, name, variant(key.type, key.default));
          },
        } satisfies SettingsApiService;
      }),
    );
  }
}
