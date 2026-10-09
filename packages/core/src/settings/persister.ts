// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Cause, Effect, Layer, PubSub, Stream } from "effect";
import { decodeSettingsMetadata, decodeValue, encodeSettingsMetadata, encodeValue, variant } from "@ibus-web/protocol";
import {
  SettingsSource,
  type SettingsChange,
  type SettingsInstance,
  type SettingsSnapshot,
  type SettingsSourceService,
} from "../services/settings.ts";
import { SyncMailbox } from "../services/logging.ts";
import { validateSetting, type SettingsSchema, type SettingValue } from "./api.ts";
import { decodeSettingsBroadcast, settingsBroadcast, type SettingsBroadcast } from "./broadcast.ts";
interface Job {
  readonly run: () => Promise<readonly SettingsChange[]>;
  readonly resolve?: () => void;
  readonly reject?: (cause: unknown) => void;
}
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
const sameKeys = (a: SettingsSchema, b: SettingsSchema) =>
  JSON.stringify(encodeSettingsMetadata({ schemas: [{ ...a, paths: b.paths }] })) ===
  JSON.stringify(encodeSettingsMetadata({ schemas: [b] }));
/** The database is acquired only by the first read or write, never by importing the service. */
export function indexedDbSettings(): Layer.Layer<SettingsSource> {
  return Layer.effect(
    SettingsSource,
    Effect.gen(function* () {
      // Modules can declare different schemas at one path, so a path holds a set of schema ids.
      const schemas = new Map<string, SettingsSchema>();
      const atPath = new Map<string, Set<string>>();
      const current = new Map<string, SettingValue>();
      const mailbox = new SyncMailbox<Job>();
      const pending = new Set<Job>();
      const transactions = new Set<IDBTransaction>();
      const pubsub = yield* PubSub.unbounded<SettingsChange>();
      let database: Promise<IDBDatabase> | undefined;
      let closed = false;
      const alive = () => {
        if (closed) throw new Error("Settings source closed");
      };
      const open = () => {
        alive();
        return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
          let abandoned = false;
          const request = indexedDB.open("gsettings", 1);
          const failed = (cause: unknown) => {
            abandoned = true;
            database = undefined;
            reject(cause);
          };
          request.onupgradeneeded = () => {
            if (closed || abandoned) request.transaction?.abort();
            else request.result.createObjectStore("values");
          };
          request.onerror = () => failed(request.error);
          request.onblocked = () => failed(new Error("Settings database upgrade blocked"));
          request.onsuccess = () => {
            if (closed || abandoned) {
              request.result.close();
              reject(new Error("Settings source closed"));
              return;
            }
            request.result.onversionchange = () => {
              request.result.close();
              database = undefined;
            };
            resolve(request.result);
          };
        }));
      };
      const transaction = async <A>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => () => A): Promise<A> => {
        const db = await open();
        alive();
        return new Promise<A>((resolve, reject) => {
          const tx = db.transaction("values", mode);
          transactions.add(tx);
          tx.oncomplete = () => {
            transactions.delete(tx);
            resolve(result());
          };
          tx.onabort = tx.onerror = () => {
            transactions.delete(tx);
            reject(tx.error ?? new Error("Settings transaction aborted"));
          };
          let result: () => A;
          try {
            result = body(tx.objectStore("values"));
          } catch (cause) {
            tx.abort();
            reject(cause);
          }
        });
      };
      const schemaOf = (instance: SettingsInstance) => {
        const schema = atPath.get(instance.path)?.has(instance.schemaId) ? schemas.get(instance.schemaId) : undefined;
        if (!schema) throw new Error(`Unknown settings instance: ${instance.schemaId} at ${instance.path}`);
        return schema;
      };
      const setting = (instance: SettingsInstance, name: string) => {
        const key = schemaOf(instance).keys.find((key) => key.name === name);
        if (!key) throw new Error(`Unknown setting: ${instance.path}${name}`);
        return key;
      };
      const memoryKey = (instance: SettingsInstance, key: string) => `${instance.schemaId}\0${instance.path}\0${key}`;
      const remember = (change: SettingsChange) => {
        current.set(memoryKey(change, change.key), change.value);
      };
      const destinations = (message: SettingsBroadcast, origin?: symbol): SettingsChange[] => {
        const supplied: SettingValue | undefined =
          message.bytes === null
            ? undefined
            : variant(message.type, decodeValue(message.type, new Uint8Array(message.bytes)));
        const changes: SettingsChange[] = [];
        for (const id of atPath.get(message.schemaPath) ?? []) {
          const key = schemas.get(id)!.keys.find((key) => key.name === message.key);
          if (!key) continue;
          const value: SettingValue = supplied ?? variant(key.type, key.default);
          try {
            validateSetting(key, value);
          } catch {
            // Shared storage does not make a value valid for every schema using that path.
            continue;
          }
          changes.push({
            schemaId: id,
            path: message.schemaPath,
            key: key.name,
            value,
            ...(origin === undefined ? {} : { origin }),
          });
        }
        return changes;
      };
      const remote = async (input: unknown): Promise<SettingsChange[]> => {
        const changes = destinations(decodeSettingsBroadcast(input));
        for (const change of changes) remember(change);
        return changes;
      };
      const broadcast = settingsBroadcast((value) => {
        if (!closed) mailbox.enqueue({ run: () => remote(value) });
      });
      const persist = async (change: SettingsChange): Promise<SettingsChange[]> => {
        const key = setting(change, change.key);
        const bytes = validateSetting(key, change.value);
        const reset = sameBytes(bytes, encodeValue(key.type, key.default));
        const message: SettingsBroadcast = {
          schemaPath: change.path,
          key: key.name,
          type: key.type,
          bytes: reset ? null : bytes.slice().buffer,
        };
        await transaction("readwrite", (store) => {
          if (reset) store.delete([change.path, key.name]);
          else store.put({ type: key.type, bytes: message.bytes }, [change.path, key.name]);
          return () => undefined;
        });
        alive();
        const changes = destinations(message, change.origin);
        for (const item of changes) remember(item);
        broadcast.post(message);
        return changes;
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
          mailbox.close();
          broadcast.close();
          for (const tx of transactions) tx.abort();
          for (const job of pending) job.reject?.(new Error("Settings source closed"));
          pending.clear();
          void database?.then(
            (db) => db.close(),
            () => {},
          );
        }),
      );
      yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));
      yield* mailbox.take.pipe(
        Effect.flatMap((job) =>
          Effect.gen(function* () {
            const result = yield* Effect.tryPromise({ try: job.run, catch: (cause) => cause }).pipe(Effect.exit);
            if (result._tag === "Success") {
              for (const change of result.value) yield* PubSub.publish(pubsub, change);
              job.resolve?.();
            } else {
              const cause = result.cause;
              if (job.reject) job.reject(Cause.squash(cause));
              else yield* Effect.logError("Settings change failed", cause);
            }
            pending.delete(job);
          }),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      const submit = (run: Job["run"]) =>
        new Promise<void>((resolve, reject) => {
          if (closed) {
            reject(new Error("Settings source closed"));
            return;
          }
          const job = { run, resolve, reject };
          pending.add(job);
          mailbox.enqueue(job);
        });
      const snapshot = async (instances: readonly SettingsInstance[]): Promise<SettingsSnapshot> => {
        await submit(async () => []);
        const selected = instances.map((instance) => ({ instance, schema: schemaOf(instance) }));
        const raw = await transaction("readonly", (store) => {
          const requests = selected.map(({ instance, schema }) => ({
            instance,
            keys: schema.keys.map((key) => ({
              key,
              request: store.get([instance.path, key.name]) as IDBRequest<unknown>,
            })),
          }));
          return () => requests;
        });
        return Object.fromEntries(
          raw.map(({ instance, keys }) => [
            instance.path,
            Object.fromEntries(
              keys.flatMap(({ key, request }) => {
                if (request.result === undefined) return [];
                const record = request.result as { type?: unknown; bytes?: unknown };
                if (record.type !== key.type || !(record.bytes instanceof ArrayBuffer))
                  throw new Error(`Invalid stored setting: ${instance.path}${key.name}`);
                const value: SettingValue = variant(key.type, decodeValue(key.type, new Uint8Array(record.bytes)));
                validateSetting(key, value);
                return [[key.name, value]];
              }),
            ),
          ]),
        );
      };
      return {
        register: (metadata) => {
          alive();
          const validated = decodeSettingsMetadata(encodeSettingsMetadata(metadata));
          for (const schema of validated.schemas) {
            const existing = schemas.get(schema.id);
            if (existing && !sameKeys(existing, schema)) throw new Error(`Conflicting settings schema: ${schema.id}`);
          }
          for (const schema of validated.schemas) {
            const existing = schemas.get(schema.id);
            schemas.set(
              schema.id,
              existing ? { ...existing, paths: [...new Set([...existing.paths, ...schema.paths])] } : schema,
            );
            for (const path of schema.paths) {
              let ids = atPath.get(path);
              if (!ids) {
                ids = new Set();
                atPath.set(path, ids);
              }
              ids.add(schema.id);
            }
          }
        },
        snapshot,
        read: async (instance, key) => {
          await submit(async () => []);
          return current.get(memoryKey(instance, key)) ?? (await snapshot([instance]))[instance.path]?.[key];
        },
        written: (change) => {
          if (!closed) mailbox.enqueue({ run: () => persist(change) });
        },
        write: (change) => submit(() => persist(change)),
        changes: Stream.fromPubSub(pubsub),
      } satisfies SettingsSourceService;
    }),
  );
}
