// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Context, Effect, Layer } from "effect";
import { asError, Persist, type ModuleManifest } from "@ibus-web/protocol";
import {
  engineDatabase,
  engineDataDatabase,
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
}
export interface StorageApiService {
  usage(): Effect.Effect<StorageUsage, Error>;
  /** The module's user data as a tar archive, from one read-only snapshot, once a running Worker has persisted. */
  export(module: string): Effect.Effect<Blob, Error>;
  /** Deletes the module's user data; a module that was running starts again, its selection restored. */
  reset(module: string): Effect.Effect<void, Error>;
}

const databasesOf = (manifest: ModuleManifest): ModuleDatabases => ({
  user: engineDatabase(manifest),
  data: engineDataDatabase(manifest),
  version: manifest.version,
  paths: [...new Set(manifest.engines.flatMap(({ data }) => data ?? []))],
});

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
              // What the engines keep only in memory, written first, so that the snapshot takes it in.
              const state = registry.state(module);
              if (state === "ready" || state === "busy")
                yield* Effect.tryPromise({
                  try: () => registry.request(module, new Persist({}), 0),
                  catch: asError,
                });
              const reply = yield* ask(module, { type: "export", database: engineDatabase(manifest) });
              if (reply.type !== "export")
                return yield* Effect.fail(new Error(`storage Worker answered ${reply.type}`));
              return new Blob([reply.archive], { type: "application/x-tar" });
            }),
          reset: (module) =>
            Effect.gen(function* () {
              const manifest = yield* manifestOf(module);
              const selection = router.selection;
              const running = registry.started(module);
              if (running) yield* router.unload(module);
              // A Worker the page just ended may keep the writer lock a while, and a module started meanwhile
              // would run read-only.
              yield* (options.waitForWriter ?? lockWait)(manifest.name).pipe(Effect.timeout(10_000), Effect.ignore);
              const reply = yield* ask(module, {
                type: "reset",
                database: engineDatabase(manifest),
                limitMs: options.resetLimitMs ?? 10_000,
              });
              if (reply.type !== "reset") return yield* Effect.fail(new Error(`storage Worker answered ${reply.type}`));
              if (selection?.module === module) yield* router.select(module, selection.engine);
              else if (running) yield* registry.start(module);
            }),
        } satisfies StorageApiService;
      }),
    );
  }
}
