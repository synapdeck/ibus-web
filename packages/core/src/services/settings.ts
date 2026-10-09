// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Context, Effect, Layer, PubSub, Stream } from "effect";
import type { GVariantVariant, SettingWritten, SettingsMetadata } from "@ibus-web/protocol";
import { indexedDbSettings } from "../settings/persister.ts";
import { SyncMailbox } from "./logging.ts";

/** A schema id at one of its paths. Modules may declare different schemas at one path. */
export interface SettingsInstance {
  readonly schemaId: string;
  readonly path: string;
}
/** Stored values by instance path, then key. */
export type SettingsSnapshot = Record<string, Record<string, typeof GVariantVariant.Type>>;
export type SettingsChange = SettingsInstance & Pick<SettingWritten, "key" | "value"> & { readonly origin?: symbol };
export interface SettingsSourceService {
  /** Optional persistence hooks keep host-provided in-memory sources compatible. */
  register?(metadata: SettingsMetadata): void | Promise<void>;
  write?(record: SettingsChange): Promise<void>;
  read?(instance: SettingsInstance, key: string): Promise<typeof GVariantVariant.Type | undefined>;
  snapshot(instances: readonly SettingsInstance[]): Promise<SettingsSnapshot>;
  /** Enqueue only; the default source reports asynchronous write failures through Effect logging. */
  written(record: SettingsChange): void;
  readonly changes: Stream.Stream<SettingsChange>;
}

export class SettingsSource extends Context.Service<SettingsSource, SettingsSourceService>()(
  "@ibus-web/core/SettingsSource",
) {
  static layer(initial: SettingsSnapshot = {}) {
    return Layer.effect(
      SettingsSource,
      Effect.gen(function* () {
        const values = new Map(Object.entries(initial).map(([path, keys]) => [path, new Map(Object.entries(keys))]));
        const mailbox = new SyncMailbox<SettingsChange>();
        yield* Effect.addFinalizer(() => Effect.sync(() => mailbox.close()));
        const pubsub = yield* PubSub.unbounded<SettingsChange>();

        yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));
        yield* mailbox.take.pipe(
          Effect.flatMap((change) => PubSub.publish(pubsub, change)),
          Effect.forever,
          Effect.forkScoped,
        );

        return {
          snapshot: async (instances: readonly SettingsInstance[]) =>
            Object.fromEntries(instances.map(({ path }) => [path, Object.fromEntries(values.get(path) ?? [])])),
          written: (record: SettingsChange) => {
            if (mailbox.isClosed) return;

            let instance = values.get(record.path);
            if (!instance) {
              instance = new Map();
              values.set(record.path, instance);
            }

            instance.set(record.key, record.value);
            mailbox.enqueue(record);
          },
          changes: Stream.fromPubSub(pubsub),
        };
      }),
    );
  }

  private static defaultLayer: Layer.Layer<SettingsSource> | undefined;
  static get Default(): Layer.Layer<SettingsSource> {
    return (this.defaultLayer ??= indexedDbSettings());
  }
}
