// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Cause, Effect, Layer, PubSub, Stream } from "effect";
import { decodeSettingsMetadata, decodeValue, encodeSettingsMetadata, encodeValue } from "@ibus-web/protocol";
import {
  SettingsSource,
  type SettingsChange,
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
/** The database is acquired only by the first read or write, never by importing the service. */
export function indexedDbSettings(): Layer.Layer<SettingsSource> {
  return Layer.effect(
    SettingsSource,
    Effect.gen(function* () {
      const schemas = new Map<string, SettingsSchema>();
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
      const setting = (schemaId: string, name: string) => {
        const schema = schemas.get(schemaId),
          key = schema?.keys.find((key) => key.name === name);
        if (!schema || !key) throw new Error(`Unknown setting: ${schemaId}.${name}`);
        return { schema, key };
      };
      const remember = (change: SettingsChange) => {
        current.set(`${change.schemaId}\0${change.key}`, change.value);
      };
      const remote = async (input: unknown): Promise<SettingsChange[]> => {
        const message = decodeSettingsBroadcast(input);
        const changes: SettingsChange[] = [];
        for (const schema of schemas.values()) {
          if (schema.path !== message.schemaPath) continue;
          const { key } = setting(schema.id, message.key);
          const value: SettingValue = {
            _tag: "v",
            type: message.type,
            value: message.bytes === null ? key.default : decodeValue(message.type, new Uint8Array(message.bytes)),
          };
          validateSetting(key, value);
          changes.push({ schemaId: schema.id, key: key.name, value });
        }
        for (const change of changes) remember(change);
        return changes;
      };
      const broadcast = settingsBroadcast((value) => {
        if (!closed) mailbox.enqueue({ run: () => remote(value) });
      });
      const persist = async (change: SettingsChange): Promise<SettingsChange[]> => {
        const { schema, key } = setting(change.schemaId, change.key);
        const bytes = validateSetting(key, change.value);
        const reset = sameBytes(bytes, encodeValue(key.type, key.default));
        const message: SettingsBroadcast = {
          schemaPath: schema.path,
          key: key.name,
          type: key.type,
          bytes: reset ? null : bytes.slice().buffer,
        };
        await transaction("readwrite", (store) => {
          if (reset) store.delete([schema.path, key.name]);
          else store.put({ type: key.type, bytes: message.bytes }, [schema.path, key.name]);
          return () => undefined;
        });
        alive();
        const changes = [...schemas.values()]
          .filter((other) => other.path === schema.path)
          .map((other) => ({ ...change, schemaId: other.id }));
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
      const snapshot = async (ids: readonly string[]): Promise<SettingsSnapshot> => {
        await submit(async () => []);
        const selected = ids.map((id) => {
          const schema = schemas.get(id);
          if (!schema) throw new Error(`Unknown settings schema: ${id}`);
          return schema;
        });
        const raw = await transaction("readonly", (store) => {
          const requests = selected.map((schema) => ({
            schema,
            keys: schema.keys.map((key) => ({
              key,
              request: store.get([schema.path, key.name]) as IDBRequest<unknown>,
            })),
          }));
          return () => requests;
        });
        return Object.fromEntries(
          raw.map(({ schema, keys }) => [
            schema.id,
            Object.fromEntries(
              keys.flatMap(({ key, request }) => {
                if (request.result === undefined) return [];
                const record = request.result as { type?: unknown; bytes?: unknown };
                if (record.type !== key.type || !(record.bytes instanceof ArrayBuffer))
                  throw new Error(`Invalid stored setting: ${schema.id}.${key.name}`);
                const value: SettingValue = {
                  _tag: "v",
                  type: key.type,
                  value: decodeValue(key.type, new Uint8Array(record.bytes)),
                };
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
            if (
              existing &&
              JSON.stringify(encodeSettingsMetadata({ schemas: [existing] })) !==
                JSON.stringify(encodeSettingsMetadata({ schemas: [schema] }))
            )
              throw new Error(`Conflicting settings schema: ${schema.id}`);
          }
          for (const schema of validated.schemas) schemas.set(schema.id, schema);
        },
        snapshot,
        read: async (schemaId, key) => {
          await submit(async () => []);
          return current.get(`${schemaId}\0${key}`) ?? (await snapshot([schemaId]))[schemaId]?.[key];
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
