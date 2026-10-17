// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Context, Effect, Exit, Layer } from "effect";
import { asError, Persist, type ModuleManifest } from "@ibus-web/protocol";
import {
  engineDatabase,
  engineDataDatabase,
  engineWriterLock,
  type DatabaseUsage,
  type ModuleDatabases,
  type StorageReply,
  type StorageRequest,
} from "@ibus-web/worker-host";
import { StorageUnavailable } from "../errors.ts";
import { Router } from "../router/router.ts";
import { waitForWriter as lockWait, type WaitForWriter } from "../router/restart.ts";
import { ModuleRegistry } from "../services/modules.ts";

/** Bytes of file data: an engine's own data, as installed. */
export interface EngineUsage {
  readonly data: number;
}
/**
 * A module's storage, in bytes of file data: its version's installed data, base and every engine's own, its own files,
 * and each engine's own data.
 */
export interface ModuleUsage {
  readonly data: number;
  readonly userData: number;
  readonly engines: Readonly<Record<string, EngineUsage>>;
}
/** Every module's, by the name the page gave it. */
export interface StorageUsage {
  readonly modules: Readonly<Record<string, ModuleUsage>>;
}
export interface StorageOptions {
  /** The host's Worker script, beside which the storage Worker's, storage.js, is served. */
  readonly hostUrl: URL;
  readonly modules: Readonly<Record<string, URL>>;
  readonly storageWorker?: (url: URL) => Worker;
  readonly waitForWriter?: WaitForWriter;
  /** How long a reset waits for other tabs' connections to the module's user data to close. */
  readonly resetLimitMs?: number;
  /** How long an export waits for the tab whose Worker holds the module's writer lock to persist. */
  readonly writerPersistMs?: number;
}
export interface StorageApiService {
  usage(): Effect.Effect<StorageUsage, Error>;
  /**
   * The module's user data as a tar archive, from one read-only snapshot, once the Worker writing it, in this tab or
   * another, has persisted.
   */
  export(module: string): Effect.Effect<Blob, Error>;
  /**
   * Deletes the module's user data; a module that was running starts again, the page's selection and the surfaces'
   * overrides that named it restored.
   */
  reset(module: string): Effect.Effect<void, Error>;
}

const databasesOf = (manifest: ModuleManifest): ModuleDatabases => ({
  user: engineDatabase(manifest),
  data: engineDataDatabase(manifest),
  version: manifest.version,
  paths: [...new Set(manifest.engines.flatMap(({ data }) => data ?? []))],
});

// Between tabs, on one channel: an export asks the tab whose Worker writes the module's user data to persist, and that
// tab answers once it has.
type PersistMessage =
  | { readonly type: "persist"; readonly name: string; readonly id: string }
  | { readonly type: "persisted"; readonly id: string };

const persistChannel = "ibus-web:storage";

const isPersistMessage = (value: unknown): value is PersistMessage => {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    (message.type === "persist" && typeof message.name === "string" && typeof message.id === "string") ||
    (message.type === "persisted" && typeof message.id === "string")
  );
};

const writerHeld = (name: string): Promise<boolean> =>
  typeof navigator === "undefined" || navigator.locks === undefined
    ? Promise.resolve(false)
    : navigator.locks
        .query()
        .then(({ held = [] }) => held.some((lock) => lock.name === engineWriterLock({ name })))
        .catch(() => false);

const usageOf = (manifest: ModuleManifest, { userData, base, paths }: DatabaseUsage): ModuleUsage => ({
  data: Object.values(paths).reduce((sum, bytes) => sum + bytes, base),
  userData,
  engines: Object.fromEntries(
    manifest.engines.map(({ name, data }) => [
      name,
      { data: (data ?? []).reduce((sum, path) => sum + (paths[path] ?? 0), 0) },
    ]),
  ),
});

export class StorageApi extends Context.Service<StorageApi, StorageApiService>()("@ibus-web/core/StorageApi") {
  static layer(options: StorageOptions) {
    return Layer.effect(
      StorageApi,
      Effect.gen(function* () {
        const registry = yield* ModuleRegistry;
        const router = yield* Router;
        const url = new URL("storage.js", options.hostUrl);

        const answered = new Map<string, () => void>();
        const channel = yield* Effect.acquireRelease(
          Effect.sync(() =>
            typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(persistChannel),
          ),
          (channel) => Effect.sync(() => channel?.close()),
        );
        if (channel)
          channel.onmessage = ({ data }: MessageEvent<unknown>) => {
            if (!isPersistMessage(data)) return;
            if (data.type === "persisted") {
              answered.get(data.id)?.();
              return;
            }

            const writers = Object.keys(options.modules).filter(
              (module) => registry.snapshot(module)?.manifest?.name === data.name && registry.writable(module),
            );
            if (writers.length === 0) return;
            void Promise.allSettled(writers.map((module) => registry.request(module, new Persist({}), 0))).then(() =>
              channel.postMessage({ type: "persisted", id: data.id } satisfies PersistMessage),
            );
          };

        // Another tab's writer that doesn't answer in time leaves the export what is already stored.
        const persistElsewhere = (name: string): Effect.Effect<void> =>
          Effect.callback<void>((resume) => {
            if (!channel) {
              resume(Effect.void);
              return;
            }
            const id = crypto.randomUUID();
            const done = () => {
              clearTimeout(timer);
              answered.delete(id);
              resume(Effect.void);
            };
            const timer = setTimeout(done, options.writerPersistMs ?? 5_000);
            answered.set(id, done);
            channel.postMessage({ type: "persist", name, id } satisfies PersistMessage);
            return Effect.sync(() => {
              clearTimeout(timer);
              answered.delete(id);
            });
          });

        // One request a Worker of its own, which the page ends once it has answered.
        const ask = (module: string, request: StorageRequest): Effect.Effect<StorageReply, Error> =>
          Effect.callback<StorageReply, Error>((resume) => {
            const unavailable = (diagnostic: string) =>
              resume(Effect.fail(new StorageUnavailable({ module, diagnostic })));
            let worker: Worker;
            try {
              worker = options.storageWorker?.(url) ?? new Worker(url, { type: "module" });
            } catch (cause) {
              unavailable(asError(cause).message);
              return;
            }
            worker.addEventListener("message", ({ data }: MessageEvent<StorageReply>) => {
              worker.terminate();
              if (data.type === "error") unavailable(data.message);
              else resume(Effect.succeed(data));
            });
            worker.addEventListener("error", (event) => {
              worker.terminate();
              unavailable(event.message || "the storage Worker failed");
            });
            worker.postMessage(request);
            return Effect.sync(() => worker.terminate());
          });

        const manifestOf = (module: string) =>
          Effect.gen(function* () {
            if (!Object.hasOwn(options.modules, module))
              return yield* Effect.fail(new Error(`Unknown module: ${module}`));
            yield* registry.engines(module);
            return registry.snapshot(module)!.manifest!;
          });

        return {
          usage: () =>
            Effect.gen(function* () {
              const usages = yield* Effect.forEach(Object.keys(options.modules), (module) =>
                Effect.gen(function* () {
                  const manifest = yield* manifestOf(module);
                  const reply = yield* ask(module, { type: "usage", modules: [databasesOf(manifest)] });
                  if (reply.type !== "usage")
                    return yield* Effect.fail(new Error(`storage Worker answered ${reply.type}`));
                  return [module, usageOf(manifest, reply.modules[0]!)] as const;
                }),
              );
              return { modules: Object.fromEntries(usages) };
            }),
          export: (module) =>
            Effect.gen(function* () {
              const manifest = yield* manifestOf(module);
              // What the engines keep only in memory, written first, so that the snapshot takes it in: by this tab's
              // Worker, or by another tab's that holds the writer lock.
              if (registry.writable(module))
                yield* Effect.tryPromise({
                  try: () => registry.request(module, new Persist({}), 0),
                  catch: asError,
                });
              else if (yield* Effect.promise(() => writerHeld(manifest.name))) yield* persistElsewhere(manifest.name);
              const reply = yield* ask(module, { type: "export", database: engineDatabase(manifest) });
              if (reply.type !== "export")
                return yield* Effect.fail(new Error(`storage Worker answered ${reply.type}`));
              return new Blob([reply.archive], { type: "application/x-tar" });
            }),
          reset: (module) =>
            Effect.gen(function* () {
              const manifest = yield* manifestOf(module);
              const clear = Effect.gen(function* () {
                // A Worker the page just ended may keep the writer lock a while, and a module started meanwhile
                // would run read-only.
                yield* (options.waitForWriter ?? lockWait)(manifest.name).pipe(Effect.timeout(10_000), Effect.ignore);
                const reply = yield* ask(module, {
                  type: "reset",
                  database: engineDatabase(manifest),
                  limitMs: options.resetLimitMs ?? 10_000,
                });
                if (reply.type !== "reset")
                  return yield* Effect.fail(new Error(`storage Worker answered ${reply.type}`));
              });
              if (!registry.started(module)) return yield* clear;

              // A module running for neither the selection nor an override, prepared ahead, say, starts again too. The
              // error that ends the reset is the clearing's, if it failed.
              const exit = yield* Effect.exit(router.reload(module, clear));
              if (!registry.started(module))
                yield* Exit.isSuccess(exit) ? registry.start(module) : Effect.ignore(registry.start(module));
              return yield* exit;
            }),
        } satisfies StorageApiService;
      }),
    );
  }
}
