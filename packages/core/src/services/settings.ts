// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Context, Effect, Layer, PubSub, Stream } from "effect";
import type { GVariantVariant, SettingWritten, SettingsMetadata } from "@ibus-web/protocol";
import { indexedDbSettings } from "../settings/persister.ts";
import { SyncMailbox } from "./logging.ts";

export type SettingsSnapshot = Record<string, Record<string, typeof GVariantVariant.Type>>;
export type SettingsChange = Pick<SettingWritten, "schemaId" | "key" | "value"> & { readonly origin?: symbol };
export interface SettingsSourceService {
  /** Optional persistence hooks keep host-provided in-memory sources compatible. */
  register?(metadata: SettingsMetadata): void | Promise<void>;
  write?(record: SettingsChange): Promise<void>;
  read?(schemaId: string, key: string): Promise<typeof GVariantVariant.Type | undefined>;
  snapshot(schemas: readonly string[]): Promise<SettingsSnapshot>;
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
        const values = new Map(
          Object.entries(initial).map(([schema, keys]) => [schema, new Map(Object.entries(keys))]),
        );
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
          snapshot: async (schemas: readonly string[]) =>
            Object.fromEntries(schemas.map((schema) => [schema, Object.fromEntries(values.get(schema) ?? [])])),
          written: (record: SettingsChange) => {
            if (mailbox.isClosed) return;
            let schema = values.get(record.schemaId);
            if (!schema) {
              schema = new Map();
              values.set(record.schemaId, schema);
            }
            schema.set(record.key, record.value);
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
