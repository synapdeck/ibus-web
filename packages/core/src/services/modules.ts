// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Clock, Context, Effect, Exit, Layer, PubSub, Schema, Scope, Stream } from "effect";
import {
  asError,
  ModuleManifest,
  Init,
  type EngineDescriptor,
  SettingChanged,
  PROTOCOL_VERSION,
  transportLayout,
  type Request,
} from "@ibus-web/protocol";
import { engineDatabase, engineDataDatabase, type StorageState } from "@ibus-web/worker-host";
import {
  Connection,
  ConnectionFailed,
  PrepareFailed,
  type ConnectionOptions,
  type CrashInfo,
  type Reply,
} from "../connection/connection.ts";
import {
  crashError,
  EngineLoadFailed,
  isIbusWebError,
  PrepareEngineError,
  ProtocolError,
  ProtocolMismatch,
  RuntimeAbiMismatch,
  StorageUnavailable,
  type IbusWebError,
} from "../errors.ts";
import { keysymByName } from "../keys/keysyms.generated.ts";
import { validateKeyboard } from "../keys/manifest.ts";
import {
  KeyRouter,
  type KeyboardPolicy,
  type ModuleSnapshot,
  type ModuleState,
  type KeyConnection,
  type KeyContext,
} from "../router/keystroke.ts";
import type { AsyncKeyResult, KeySink } from "../router/replay.ts";
import { makeRestarter, type WaitForWriter } from "../router/restart.ts";
import { watchDatabases } from "../connection/watch.ts";
import { loadSettingsMetadata, settingsInstances } from "../settings/api.ts";
import {
  isKeyboardLayout,
  layoutInstances,
  layoutKey,
  layoutMetadata,
  type KeyboardLayout,
} from "../settings/layout.ts";
import { CoreConfig } from "./config.ts";
import { Logger, PanelEvents, SyncMailbox } from "./logging.ts";
import {
  browserPreload,
  cacheManifest,
  fetchEntries,
  openPreloads,
  type InstallOutcome,
  type PreloadEntry,
  type PreloadEnvironment,
  type PreloadOptions,
} from "./preload.ts";
import { SettingsSource, type SettingsChange } from "./settings.ts";
export interface ModuleRegistryOptions {
  readonly hostUrl: URL;
  readonly runtimeUrl: URL;
  /** Keys name modules; they may differ from manifest.name and from every engine's name. */
  readonly modules: Readonly<Record<string, URL>>;
  readonly storage?: "browser" | "none";
  /** Honor options.signal for partial resources; late returned connections are terminated by the registry. */
  readonly start?: (options: ConnectionOptions) => Promise<KeyConnection>;
  readonly loadManifest?: (url: URL) => Promise<unknown>;
  readonly loadMetadata?: (url: URL, signal?: AbortSignal) => Promise<unknown>;
  readonly waitForWriter?: WaitForWriter;
  /** What preloading takes of the page, each part the browser's unless given. */
  readonly preload?: Partial<PreloadEnvironment>;
}
/** A manifest's engine descriptor, with the layout its keys follow now and where the setting that chooses it lives. */
export type EngineInfo = EngineDescriptor & {
  /** The engine's layout setting, or `keyboard.layout`, the one it declares, while that is unset. */
  readonly layout: KeyboardLayout;
  /** The settings path of the engine's layout setting; an engine whose name can't form a path has none. */
  readonly layoutPath?: string;
};
export type ModuleEvent =
  /** `error` says why, with `restarting` and `failed`. */
  | {
      readonly _tag: "state";
      readonly module: string;
      readonly state: ModuleState;
      readonly error?: IbusWebError;
    }
  | { readonly _tag: "storage"; readonly module: string; readonly state: StorageState; readonly message: string }
  /**
   * While an engine's own data installs: bytes written so far of total, what the module's storage lacked. bytes reaches
   * total only once all of it is installed.
   */
  | {
      readonly _tag: "install";
      readonly module: string;
      readonly engine: string;
      readonly bytes: number;
      readonly total: number;
    }
  /**
   * While an entry preloads: bytes fetched so far of total, what the cache lacked, in the manifest's sizes. bytes
   * reaches total only once all of it is stored. engine is the entry's, if it named one; an install reports the base
   * data without one.
   */
  | {
      readonly _tag: "preload";
      readonly module: string;
      readonly engine?: string;
      readonly bytes: number;
      readonly total: number;
    };
export interface ModuleRegistryService {
  readonly events: Stream.Stream<ModuleEvent>;
  unload(name: string): Effect.Effect<void, Error>;
  /** Development aid: terminate the real connection and use normal crash recovery. */
  debugRestart(name: string): Effect.Effect<void, Error>;
  select(name: string | undefined): Effect.Effect<void, Error>;
  /** Reads and validates the module's manifest without starting its Worker. */
  engines(name: string): Effect.Effect<readonly EngineInfo[], Error>;
  /**
   * Installs the engine's own data in the module's Worker, starting it if need be, once per Worker; an engine with no
   * data of its own needs nothing. Fails with PrepareEngineError for the Worker's reason.
   */
  prepare(name: string, engine: string): Effect.Effect<void, Error>;
  /** Whether the engine can be made in the module's Worker as it is: it has no data of its own, or the Worker has it. */
  isPrepared(name: string, engine: string): boolean;
  /**
   * Once the page is idle, fetches each entry's files the page's preload cache lacks: the module's manifest, `.wasm`
   * and base data, and the engine's own data when it names one, at low priority, starting no Worker. With `install`,
   * a short-lived Worker per module installs them into its storage instead, with the module's writer lock, and a
   * module another host holds that lock for is skipped. Fails with an Error for an unknown module before anything is
   * fetched, or an unknown engine before anything but its manifest, and with the tagged errors for what failed.
   */
  preload(entries: readonly PreloadEntry[], options?: PreloadOptions): Effect.Effect<void, Error>;
  ensure(name: string): Effect.Effect<void, Error>;
  /** Starts the module's Worker, if it hasn't, and waits until it is ready, without enabling the module. */
  start(name: string): Effect.Effect<void, Error>;
  /** Whether the module's Worker has been started and not unloaded since. */
  started(name: string): boolean;
  /** Whether the module's Worker is ready and may write its user data, holding the writer lock if it uses IndexedDB. */
  writable(name: string): boolean;
  /** Has every ready Worker persist what its engines keep in memory, waiting for each that the wire lets it. */
  persist(): void;
  whenReady(name: string): Effect.Effect<void, Error>;
  state(name: string): ModuleState;
  snapshot(name: string): ModuleSnapshot | undefined;
  registerContext(name: string, context: KeyContext): () => void;
  drainContext(name: string, context: KeyContext): Promise<void>;
  captureDrainContext(name: string, context: KeyContext): () => Promise<void>;
  retireContext(name: string, context: KeyContext, beforeReplay?: () => void): void;
  holdKeys(name: string): () => void;
  keySink(name: string, context: KeyContext): KeySink;
  keyAsync(name: string, context: KeyContext, event: KeyboardEvent): Promise<AsyncKeyResult>;
  request(name: string, request: Request, ic: number): Promise<Reply>;
}
export class ModuleRegistry extends Context.Service<ModuleRegistry, ModuleRegistryService>()(
  "@ibus-web/core/ModuleRegistry",
) {
  static layer(options: ModuleRegistryOptions) {
    return Layer.effect(ModuleRegistry, makeModuleRegistry(options));
  }
}
interface Entry {
  readonly snapshot: ModuleSnapshot;
  readonly router: KeyRouter;
  readonly changes: Map<string, SettingsChange>;
  // SettingWritten carries only a path; this maps it back to the schema the persister keys on.
  readonly instances: Map<string, string>;
  // The page's own layout settings: engine name by path.
  readonly layouts: Map<string, string>;
  // Layout changes, by engine, that arrived while the stored layouts were being read; they are newer than that read.
  readonly layoutChanges: Map<string, KeyboardLayout>;
  readonly watchers: Set<() => void>;
  crashes: SyncMailbox<{ crash: CrashInfo; at: number }>;
  lifetime: Scope.Closeable | undefined;
  lastState: ModuleState | undefined;
  // Why the module last crashed or failed, while it is restarting or failed.
  error: IbusWebError | undefined;
  // A failed start's own error, for the crash that ends its connection to report in place of a load crash.
  startError: IbusWebError | undefined;
  origin: symbol;
  started: boolean;
  hasReady: boolean;
  // Whether the Worker that last reached Init may write the module's user data.
  writable: boolean;
}
// The runtime replied to Init with an error.
class InitRefused extends EngineLoadFailed {}
// A start that failed as the module's error, and whether a restart could do better: a module refused for what it is,
// or whose Init the runtime refused, fails for good.
const startupFailure = (module: string, cause: unknown): { error: IbusWebError; terminal: boolean } => {
  if (cause instanceof ConnectionFailed) {
    const { crash } = cause;
    const diagnostic = crash.message;
    if (crash.refused === "RuntimeAbiMismatch")
      return { error: new RuntimeAbiMismatch({ module, diagnostic }), terminal: true };
    if (crash.refused === "ProtocolMismatch")
      return { error: new ProtocolMismatch({ module, diagnostic }), terminal: true };
    return { error: new EngineLoadFailed({ module, diagnostic }), terminal: crash.refused === "manifest" };
  }
  if (isCrashInfo(cause)) return { error: crashError(module, cause), terminal: false };
  if (isIbusWebError(cause))
    return {
      error: cause,
      terminal:
        cause._tag === "RuntimeAbiMismatch" ||
        cause._tag === "ProtocolMismatch" ||
        cause._tag === "ProtocolError" ||
        cause instanceof InitRefused,
    };
  // The page's own request for Init didn't fit the Worker's request slot.
  if (cause instanceof RangeError)
    return { error: new ProtocolError({ module, diagnostic: cause.message }), terminal: true };
  return { error: new EngineLoadFailed({ module, diagnostic: asError(cause).message }), terminal: false };
};
const noop = (): void => {};
// What a connection rejects a request with once its Worker has crashed.
const isCrashInfo = (cause: unknown): cause is CrashInfo =>
  typeof cause === "object" &&
  cause !== null &&
  !(cause instanceof Error) &&
  typeof (cause as Partial<CrashInfo>).reason === "string" &&
  typeof (cause as Partial<CrashInfo>).message === "string";
const keyboards = (
  manifest: ModuleManifest,
  layouts: ReadonlyMap<string, KeyboardLayout> = new Map(),
): Map<string, KeyboardPolicy> =>
  new Map(
    manifest.engines.map(({ name, keyboard }) => [
      name,
      {
        layout: layouts.get(name) ?? keyboard.layout,
        passThrough: new Set(keyboard.passThrough.map((key) => keysymByName.get(key)!)),
      },
    ]),
  );
export const makeModuleRegistry = (options: ModuleRegistryOptions) =>
  Effect.gen(function* () {
    const config = yield* CoreConfig;
    const settings = yield* SettingsSource;
    const logger = yield* Logger;
    const panel = yield* PanelEvents;
    const scope = yield* Scope.Scope;
    const clock = yield* Clock.Clock;
    const entries = new Map<string, Entry>();
    const events = new SyncMailbox<ModuleEvent>();
    const pubsub = yield* PubSub.unbounded<ModuleEvent>();
    yield* Effect.addFinalizer(() => Effect.sync(() => events.close()));
    yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));
    yield* events.take.pipe(
      Effect.flatMap((event) => PubSub.publish(pubsub, event)),
      Effect.forever,
      Effect.forkScoped,
    );
    const distributions = new Map<string, string>();
    const state = (entry: Entry): ModuleState =>
      entry.snapshot.status === "ready" && entry.router.busy ? "busy" : entry.snapshot.status;
    const changed = (entry: Entry) => {
      const value = state(entry);
      if (entry.lastState !== value) {
        entry.lastState = value;
        const error = value === "restarting" || value === "failed" ? entry.error : undefined;
        events.enqueue({ _tag: "state", module: entry.snapshot.name, state: value, ...(error ? { error } : {}) });
      }
    };
    const notify = (entry: Entry) => {
      changed(entry);
      for (const watcher of entry.watchers) watcher();
    };
    // Keeps the error that ended the module, if it has one already: a restart limit or a failed wait for the writer
    // ends it for its last crash.
    const fail = (entry: Entry, error?: IbusWebError) => {
      if (error) entry.error = error;
      entry.error ??= new EngineLoadFailed({ module: entry.snapshot.name });
      entry.router.dispose();
      entry.snapshot.status = "failed";
      notify(entry);
    };
    const flushChanges = (entry: Entry) =>
      Effect.gen(function* () {
        while (entry.changes.size > 0) {
          const changes = [...entry.changes.values()];
          entry.changes.clear();
          for (const change of changes)
            yield* Effect.tryPromise({
              try: () =>
                entry.router.request(
                  new SettingChanged({ path: change.path, key: change.key, value: change.value }),
                  0,
                ),
              catch: asError,
            });
        }
      });
    const readManifest = async (name: string): Promise<ModuleManifest> => {
      const url = options.modules[name]!;
      let manifest: ModuleManifest;
      try {
        const raw = options.loadManifest
          ? await options.loadManifest(url)
          : await fetch(url).then((response) => {
              if (!response.ok) throw new Error(`Manifest fetch failed: ${response.status}`);
              return response.json();
            });
        manifest = Schema.decodeUnknownSync(ModuleManifest, { onExcessProperty: "error" })(raw);
        for (const engine of manifest.engines) validateKeyboard(engine.keyboard);
      } catch (cause) {
        throw new EngineLoadFailed({ module: name, diagnostic: asError(cause).message });
      }
      if (manifest.protocol !== PROTOCOL_VERSION)
        throw new ProtocolMismatch({
          module: name,
          diagnostic: `page ${PROTOCOL_VERSION}, manifest ${manifest.protocol}`,
        });

      const owner = distributions.get(manifest.name);
      if (owner !== undefined && owner !== name)
        throw new EngineLoadFailed({
          module: name,
          diagnostic: `distribution ${manifest.name} is already registered as ${owner}`,
        });
      distributions.set(manifest.name, name);
      return manifest;
    };
    // The layouts stored for a manifest's engines. A source that can't supply them leaves the declared layouts,
    // which a module can still type with, so it is a warning rather than a failed start.
    const storedLayouts = async (name: string, entry: Entry, manifest: ModuleManifest) => {
      const instances = layoutInstances(manifest);
      const layouts = new Map<string, KeyboardLayout>();

      entry.layouts.clear();
      entry.layoutChanges.clear();
      for (const [engine, instance] of instances) entry.layouts.set(instance.path, engine);
      if (instances.size === 0) return layouts;

      try {
        await settings.register?.(layoutMetadata(manifest));
        const stored = await settings.snapshot([...instances.values()]);
        for (const [engine, instance] of instances) {
          const value = stored[instance.path]?.[layoutKey];
          if (value?._tag === "v" && value.value._tag === "s" && isKeyboardLayout(value.value.value))
            layouts.set(engine, value.value.value);
        }
      } catch (cause) {
        logger.enqueue({
          module: name,
          ic: 0,
          record: {
            _tag: "Log",
            level: 16,
            domain: "page-settings",
            message: `Keyboard layout settings unavailable, so engines use their declared layouts: ${asError(cause).message}`,
          },
        });
      }

      for (const [engine, layout] of entry.layoutChanges) layouts.set(engine, layout);
      entry.layoutChanges.clear();
      return layouts;
    };
    // Listing engines and starting the Worker share one read; a failed read is retried on the next use.
    const reads = new Map<string, Promise<ModuleManifest>>();
    const manifestOf = (name: string, entry: Entry): Effect.Effect<ModuleManifest, Error> =>
      Effect.suspend(() => {
        if (entry.snapshot.manifest) return Effect.succeed(entry.snapshot.manifest);

        let read = reads.get(name);
        if (!read) {
          // The stored layouts are read with the manifest, so no key is translated before they are known.
          read = readManifest(name).then(
            async (manifest) => {
              const layouts = await storedLayouts(name, entry, manifest);

              reads.delete(name);
              entry.snapshot.manifest = manifest;
              entry.snapshot.keyboards = keyboards(manifest, layouts);
              return manifest;
            },
            (cause: unknown) => {
              reads.delete(name);
              throw cause;
            },
          );
          reads.set(name, read);
        }
        const pending = read;
        return Effect.tryPromise({ try: () => pending, catch: asError });
      });
    // The last install-only Worker preloading runs, by module, each waiting for the one before: a start of the module
    // waits for it, since it holds the writer lock the module's Worker would otherwise lack for good.
    const installers = new Map<string, Promise<unknown>>();
    const boot = (name: string, entry: Entry) =>
      Effect.gen(function* () {
        const lifetime = entry.lifetime!;
        const installing = installers.get(name);
        if (installing !== undefined) yield* Effect.promise(() => installing.then(noop, noop));
        const manifest = yield* manifestOf(name, entry);
        const metadata = yield* Effect.tryPromise({
          try: (signal) => loadSettingsMetadata(manifest, options.modules[name]!, options, signal),
          catch: (cause) => new EngineLoadFailed({ module: name, diagnostic: asError(cause).message }),
        });
        const unstored = (cause: unknown) =>
          new StorageUnavailable({ module: name, diagnostic: asError(cause).message });

        if (settings.register)
          yield* Effect.tryPromise({
            try: async () => {
              await settings.register!(metadata);
            },
            catch: unstored,
          });

        const instances = settingsInstances(metadata);
        const patterns = new Map(
          metadata.schemas.flatMap(({ id, pattern }) => (pattern === undefined ? [] : [[id, pattern] as const])),
        );
        entry.instances.clear();
        for (const { schemaId, path } of instances) entry.instances.set(path, schemaId);

        const initial = yield* Effect.tryPromise({
          try: () => settings.snapshot(instances),
          catch: unstored,
        });
        // The host reports its storage before it is ready, and a read-only one stays so for the Worker's life.
        let userDataWritable = true;
        let inMemory = false;
        const connection = yield* Effect.acquireRelease(
          Effect.callback<KeyConnection, Error>((resume, signal) => {
            try {
              void (options.start ?? Connection.start)({
                hostUrl: options.hostUrl,
                runtimeUrl: options.runtimeUrl,
                manifestUrl: options.modules[name]!,
                storage: options.storage ?? "browser",
                budgetMs: config.budgetMs,
                hangMs: config.hangMs,
                initHangMs: config.initHangMs,
                layout: transportLayout({ ringBytes: config.ringBytes, slotBytes: config.slotBytes }),
                signal,
                onStorage: (message) => {
                  if (message.state === "read-only") userDataWritable = false;
                  if (message.state === "ephemeral") inMemory = true;
                  if (entry.lifetime === lifetime) events.enqueue({ _tag: "storage", module: name, ...message });
                },
              }).then(
                (connection) => {
                  // An injected starter may ignore cancellation and resolve after scope closure.
                  if (signal.aborted) connection.terminate();
                  else resume(Effect.succeed(connection));
                },
                (cause) => resume(Effect.fail(asError(cause))),
              );
            } catch (cause) {
              resume(Effect.fail(asError(cause)));
            }
          }),
          // Ending the Worker runs none of its engines' finalizers, so they persist and shut down first.
          (connection) =>
            Effect.sync(() => {
              if (entry.snapshot.connection === connection) {
                entry.router.shutdown(config.hangMs);
                entry.router.disconnect();
              }
              ended(connection);
              connection.terminate();
            }),
          { interruptible: true },
        ).pipe(Scope.provide(lifetime));
        // The page hears of a version change on the module's databases for its host, which can't wake for one.
        const checkStorage = connection.checkStorage?.bind(connection);
        if (checkStorage && (options.storage ?? "browser") === "browser" && !inMemory)
          yield* Effect.acquireRelease(
            Effect.sync(() => watchDatabases([engineDatabase(manifest), engineDataDatabase(manifest)], checkStorage)),
            (stop) => Effect.sync(stop),
          ).pipe(Scope.provide(lifetime));
        entry.origin = Symbol();
        entry.router.connect(connection);
        started(connection);
        const reply = yield* Effect.tryPromise({
          try: () =>
            entry.router.request(
              new Init({
                version: PROTOCOL_VERSION,
                userDataWritable,
                // A patterned schema's instances need an entry only to carry stored values.
                settings: instances.flatMap(({ schemaId, path }) => {
                  const values = initial[path] ?? {};
                  return patterns.has(schemaId) && Object.keys(values).length === 0 ? [] : [{ schemaId, path, values }];
                }),
                patterns: [...patterns].map(([schemaId, pattern]) => ({ schemaId, pattern })),
              }),
              0,
            ),
          catch: asError,
        });
        if (reply.ret < 0)
          return yield* Effect.fail(new InitRefused({ module: name, diagnostic: `Init failed: ${reply.ret}` }));
        yield* flushChanges(entry);
        entry.writable = userDataWritable;
        entry.hasReady = true;
        entry.error = undefined;
        entry.snapshot.status = "ready";
        notify(entry);
      });
    const launch = (name: string, entry: Entry) =>
      Effect.suspend(() => {
        const generation = entry.snapshot.generation;
        return boot(name, entry).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              const { error, terminal } = startupFailure(name, cause);
              if (!entry.snapshot.manifest || terminal) {
                fail(entry, error);
                return;
              }
              // The connection's crash notification already owns this failed attempt.
              if (entry.snapshot.generation !== generation) return;
              const crash: CrashInfo = { reason: "load", message: cause.message };
              if (entry.snapshot.connection) {
                entry.startError = error;
                try {
                  entry.router.crash(crash);
                } finally {
                  entry.startError = undefined;
                }
              } else {
                entry.error = error;
                entry.snapshot.status = "restarting";
                entry.crashes.enqueue({ crash, at: clock.currentTimeMillisUnsafe() });
              }
            }),
          ),
        );
      });
    for (const name of Object.keys(options.modules)) {
      const snapshot: ModuleSnapshot = {
        name,
        status: "starting",
        enabled: false,
        generation: 0,
        connection: undefined,
        keyboards: new Map(),
      };
      const crashes = new SyncMailbox<{ crash: CrashInfo; at: number }>();
      const entry: Entry = {
        snapshot,
        crashes,
        lifetime: undefined,
        lastState: undefined,
        error: undefined,
        startError: undefined,
        origin: Symbol(),
        started: false,
        hasReady: false,
        writable: false,
        changes: new Map(),
        instances: new Map(),
        layouts: new Map(),
        layoutChanges: new Map(),
        watchers: new Set(),
        router: new KeyRouter(snapshot, {
          replayLimit: config.replayLimit,
          changed: () => changed(entry),
          enqueue: ({ ic, record }) => {
            if (record._tag === "Log") logger.enqueue({ module: name, ic, record });
            else if (record._tag === "SettingWritten") {
              const schemaId = entry.instances.get(record.path);

              // The runtime refuses writes under undeclared paths, so this is a runtime fault.
              if (schemaId === undefined)
                logger.enqueue({
                  module: name,
                  ic,
                  record: {
                    _tag: "Log",
                    level: 16,
                    domain: "page-settings",
                    message: `Setting written at an undeclared path: ${record.path}`,
                  },
                });
              else
                settings.written({
                  schemaId,
                  path: record.path,
                  key: record.key,
                  value: record.value,
                  origin: entry.origin,
                });
            }
          },
          hide: (ic) => panel.enqueue({ _tag: "hide", module: name, ic }),
          error: (cause, ic) =>
            logger.enqueue({
              module: name,
              ic,
              record: { _tag: "Log", level: 8, domain: "page-adapter", message: asError(cause).message },
            }),
          crashed: (crash) => {
            entry.error = entry.startError ?? crashError(name, crash);
            if (!entry.hasReady) {
              snapshot.status = "failed";
              notify(entry);
            } else {
              notify(entry);
              entry.crashes.enqueue({ crash, at: clock.currentTimeMillisUnsafe() });
            }
          },
        }),
      };
      entries.set(name, entry);
      yield* Effect.addFinalizer(() => Effect.sync(() => crashes.close()));
    }
    // A page going away ends its Workers, which runs none of their engines' finalizers, and a hidden one may be
    // discarded with no further event, so each has its Workers persist first. At pagehide the page waits for the
    // reply, as nothing it queues runs afterwards. WebKit's Workers reach IndexedDB through the page's main thread,
    // which that wait holds, so an engine's write there finishes only once the wait gives up; the page also persists
    // without waiting at beforeunload, before a navigation or close starts, while its main thread is still free to
    // serve the write. A hidden page goes on running, so it doesn't wait either.
    const page = typeof window !== "undefined" && typeof document !== "undefined";
    const persist = (budgetMs?: number) => {
      for (const entry of entries.values()) entry.router.persist(budgetMs);
    };
    const leaving = () => persist(config.hangMs);
    const unloading = () => persist();
    const hidden = () => {
      if (document.visibilityState === "hidden") persist();
    };
    // Firefox keeps no page with a beforeunload listener in its back/forward cache, so there is one only while a
    // Worker runs.
    const running = new Set<KeyConnection>();
    const started = (connection: KeyConnection) => {
      if (page && running.size === 0) window.addEventListener("beforeunload", unloading);
      running.add(connection);
    };
    const ended = (connection: KeyConnection) => {
      if (running.delete(connection) && page && running.size === 0)
        window.removeEventListener("beforeunload", unloading);
    };
    if (page) {
      window.addEventListener("pagehide", leaving);
      document.addEventListener("visibilitychange", hidden);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          window.removeEventListener("pagehide", leaving);
          window.removeEventListener("beforeunload", unloading);
          document.removeEventListener("visibilitychange", hidden);
        }),
      );
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const entry of entries.values()) entry.router.dispose();
      }),
    );
    yield* settings.changes.pipe(
      Stream.runForEach((change) =>
        Effect.gen(function* () {
          for (const entry of entries.values()) {
            const engine = change.key === layoutKey ? entry.layouts.get(change.path) : undefined;
            const value = change.value._tag === "v" && change.value.value._tag === "s" ? change.value.value.value : "";
            if (engine !== undefined && isKeyboardLayout(value)) {
              const keyboard = entry.snapshot.keyboards.get(engine);
              if (keyboard)
                entry.snapshot.keyboards = new Map(entry.snapshot.keyboards).set(engine, {
                  ...keyboard,
                  layout: value,
                });
              else entry.layoutChanges.set(engine, value);
              continue;
            }

            if (
              entry.instances.get(change.path) !== change.schemaId ||
              entry.snapshot.status === "failed" ||
              change.origin === entry.origin
            )
              continue;

            entry.changes.set(`${change.path}\0${change.key}`, change);

            if (entry.snapshot.status === "ready") {
              yield* flushChanges(entry).pipe(Effect.catchCause(() => Effect.void));
            }
          }
        }),
      ),
      Effect.forkScoped,
    );
    const get = (name: string) => {
      const entry = entries.get(name);
      if (!entry) throw new Error(`Unknown module: ${name}`);
      return entry;
    };
    const whenReady = (name: string): Effect.Effect<void, Error> =>
      Effect.callback((resume) => {
        const entry = entries.get(name);
        if (!entry) {
          resume(Effect.fail(new Error(`Unknown module: ${name}`)));
          return;
        }
        const check = () => {
          if (entry.snapshot.status === "ready") {
            entry.watchers.delete(check);
            resume(Effect.void);
          } else if (entry.snapshot.status === "failed") {
            entry.watchers.delete(check);
            resume(Effect.fail(entry.error ?? new EngineLoadFailed({ module: name })));
          } else if (entry.snapshot.status === "unloaded") {
            entry.watchers.delete(check);
            resume(Effect.fail(new Error(`Module ${name} unloaded`)));
          }
        };
        entry.watchers.add(check);
        check();
        return Effect.sync(() => {
          entry.watchers.delete(check);
        });
      });
    const startLifetime = (name: string, entry: Entry) =>
      Effect.gen(function* () {
        entry.lifetime = Scope.forkUnsafe(scope, "sequential");
        entry.crashes = new SyncMailbox();
        const crashes = entry.crashes;
        yield* Scope.addFinalizer(
          entry.lifetime,
          Effect.sync(() => crashes.close()),
        );
        const restarter = yield* makeRestarter(config.restart, options.waitForWriter);
        yield* entry.crashes.take.pipe(
          Effect.flatMap(({ crash, at }) =>
            Effect.gen(function* () {
              if (entry.snapshot.status === "failed") return;
              if (!restarter.record(at)) {
                fail(entry);
                return;
              }
              const wait = yield* Effect.exit(restarter.wait(entry.snapshot.manifest!.name, crash.storage));
              if (wait._tag === "Failure") {
                fail(entry);
                return;
              }
              yield* launch(name, entry);
            }),
          ),
          Effect.forever,
          Effect.forkIn(entry.lifetime!),
        );
      });
    // Starts the module's Worker, if it hasn't, and waits until it is ready.
    const start = (name: string): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const entry = get(name);
        if (!entry.started) {
          entry.started = true;
          entry.snapshot.status = "starting";
          yield* startLifetime(name, entry);
          notify(entry);
          yield* boot(name, entry).pipe(
            Effect.catch((cause) => Effect.sync(() => fail(entry, startupFailure(name, cause).error))),
            Effect.forkIn(entry.lifetime!),
          );
        }
        yield* whenReady(name);
      });
    const ensure = (name: string): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        if (!entries.has(name)) return yield* Effect.fail(new Error(`Unknown module: ${name}`));
        get(name).snapshot.enabled = true;
        yield* start(name);
      });
    // By connection, so that a restarted Worker prepares again; a failed install is forgotten, to be tried again.
    const prepared = new WeakMap<KeyConnection, Map<string, Promise<void>>>();
    const installed = new WeakMap<KeyConnection, Set<string>>();
    const prepare = (name: string, engine: string): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const entry = entries.get(name);
        if (!entry) return yield* Effect.fail(new Error(`Unknown module: ${name}`));
        const manifest = yield* manifestOf(name, entry);
        const descriptor = manifest.engines.find((candidate) => candidate.name === engine);
        if (!descriptor) return yield* Effect.fail(new Error(`Unknown engine: ${engine} in module ${name}`));
        if ((descriptor.data ?? []).length === 0) return;
        yield* start(name);
        const connection = entry.snapshot.connection;
        if (!connection) return yield* Effect.fail(new Error(`Module ${name} is not ready`));

        let engines = prepared.get(connection);
        if (!engines) {
          engines = new Map();
          prepared.set(connection, engines);
        }
        let pending = engines.get(engine);
        if (!pending) {
          const installing = connection.prepare(engine, (bytes, total) =>
            events.enqueue({ _tag: "install", module: name, engine, bytes, total }),
          );
          const byEngine = engines;
          installing.then(
            () => {
              const done = installed.get(connection) ?? new Set<string>();
              installed.set(connection, done.add(engine));
            },
            () => {
              if (byEngine.get(engine) === installing) byEngine.delete(engine);
            },
          );
          engines.set(engine, installing);
          pending = installing;
        }
        const waiting = pending;
        yield* Effect.tryPromise({
          try: () => waiting,
          catch: (cause) =>
            cause instanceof PrepareFailed
              ? new PrepareEngineError({ module: name, engine, diagnostic: cause.message })
              : isCrashInfo(cause)
                ? crashError(name, cause)
                : asError(cause),
        });
      });
    const preloading: PreloadEnvironment = { ...browserPreload, ...options.preload };
    // An entry's progress, if the page asked for that entry, and an install's base data, which has no engine, for any
    // entry of its module.
    const preloaded =
      (requested: readonly PreloadEntry[], module: string) =>
      (engine: string | undefined, bytes: number, total: number) => {
        if (requested.some((entry) => entry.module === module && (engine === undefined || entry.engine === engine)))
          events.enqueue({ _tag: "preload", module, ...(engine === undefined ? {} : { engine }), bytes, total });
      };
    // Installs a module's entries, through its Worker if this page runs it, which holds the writer lock, or else
    // through a Worker of their own, which a start of the module waits for. Resolves with how it went.
    const install = (
      name: string,
      manifest: ModuleManifest,
      requested: readonly PreloadEntry[],
    ): Effect.Effect<InstallOutcome, Error> =>
      Effect.gen(function* () {
        const engines = [
          ...new Set(
            requested.flatMap(({ module, engine }) =>
              module === name &&
              engine !== undefined &&
              (manifest.engines.find((descriptor) => descriptor.name === engine)?.data ?? []).length > 0
                ? [engine]
                : [],
            ),
          ),
        ];
        const prepared = Effect.gen(function* () {
          for (const engine of engines) yield* prepare(name, engine);
          return "installed" as const;
        });
        if (get(name).started) return yield* prepared;

        // One install-only Worker of a module at a time: a second would find the first holding the writer lock and
        // install nothing. The module may have started by the time the last one ends, its Worker then holding the
        // lock, so that Worker installs instead.
        const previous = installers.get(name);
        const installing = (async (): Promise<InstallOutcome | "started"> => {
          await previous?.then(noop, noop);
          if (get(name).started) return "started";
          return preloading.install({
            module: name,
            hostUrl: options.hostUrl,
            runtimeUrl: options.runtimeUrl,
            manifestUrl: options.modules[name]!,
            engines,
            progress: preloaded(requested, name),
          });
        })();
        installers.set(name, installing);
        const outcome = yield* Effect.tryPromise({
          try: () => installing,
          catch: (cause) =>
            isIbusWebError(cause) ? cause : new EngineLoadFailed({ module: name, diagnostic: asError(cause).message }),
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (installers.get(name) === installing) installers.delete(name);
            }),
          ),
        );
        return outcome === "started" ? yield* prepared : outcome;
      });
    const preload = (
      requested: readonly PreloadEntry[],
      preloadOptions: PreloadOptions = {},
    ): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        for (const { module } of requested)
          if (!entries.has(module)) return yield* Effect.fail(new Error(`Unknown module: ${module}`));
        yield* Effect.promise(() => preloading.idle());

        const modules = [...new Set(requested.map(({ module }) => module))];
        const manifests = new Map<string, ModuleManifest>();
        for (const name of modules) manifests.set(name, yield* manifestOf(name, get(name)));
        for (const { module, engine } of requested) {
          if (engine !== undefined && !manifests.get(module)!.engines.some(({ name }) => name === engine))
            return yield* Effect.fail(new Error(`Unknown engine: ${engine} in module ${module}`));
        }

        // A module whose storage would be memory keeps nothing installed, so its files are fetched instead.
        let fetching = modules;
        if (preloadOptions.install === true) {
          fetching = [];
          for (const name of modules)
            if ((yield* install(name, manifests.get(name)!, requested)) === "ephemeral") fetching.push(name);
        }

        yield* Effect.tryPromise({
          try: async () => {
            const cache = await openPreloads(preloading);
            if (cache === undefined) return;
            for (const name of fetching) {
              const manifest = manifests.get(name)!;
              const own = requested.filter(({ module }) => module === name);
              try {
                const base = await cacheManifest(preloading, cache, name, options.modules[name]!, manifest);
                await fetchEntries(
                  preloading,
                  cache,
                  name,
                  manifest,
                  base,
                  own.map(({ engine }) => engine),
                  (index, bytes, total) => preloaded(requested, name)(own[index]!.engine, bytes, total),
                );
              } catch (cause) {
                throw isIbusWebError(cause)
                  ? cause
                  : new EngineLoadFailed({ module: name, diagnostic: asError(cause).message });
              }
            }
          },
          catch: asError,
        });
      });
    const service: ModuleRegistryService = {
      events: Stream.fromPubSub(pubsub),
      unload: (name) =>
        Effect.gen(function* () {
          const entry = entries.get(name);
          if (!entry) return yield* Effect.fail(new Error(`Unknown module: ${name}`));
          entry.router.shutdown(config.hangMs);
          const lifetime = entry.lifetime;
          entry.lifetime = undefined;
          entry.snapshot.enabled = false;
          entry.snapshot.generation++;
          entry.router.dispose();
          entry.snapshot.status = "unloaded";
          entry.error = undefined;
          entry.started = false;
          entry.hasReady = false;
          entry.changes.clear();
          entry.crashes.close();
          notify(entry);
          if (lifetime) yield* Scope.close(lifetime, Exit.void);
        }),
      debugRestart: (name) =>
        Effect.gen(function* () {
          const entry = entries.get(name);
          if (!entry?.snapshot.connection || entry.snapshot.status !== "ready")
            return yield* Effect.fail(new Error(`Module ${name} is not ready`));
          entry.router.crash({ reason: "worker", message: "Debug restart" });
          yield* whenReady(name);
        }),
      ensure,
      start: (name) =>
        Effect.suspend(() => (entries.has(name) ? start(name) : Effect.fail(new Error(`Unknown module: ${name}`)))),
      started: (name) => get(name).started,
      writable: (name) => {
        const entry = get(name);
        const value = state(entry);
        return entry.writable && (value === "ready" || value === "busy");
      },
      persist: leaving,
      prepare,
      preload,
      isPrepared: (name, engine) => {
        const snapshot = entries.get(name)?.snapshot;
        const descriptor = snapshot?.manifest?.engines.find((candidate) => candidate.name === engine);
        if (descriptor === undefined) return false;
        if ((descriptor.data ?? []).length === 0) return true;
        return snapshot!.connection !== undefined && (installed.get(snapshot!.connection)?.has(engine) ?? false);
      },
      engines: (name) =>
        Effect.suspend(() => {
          const entry = entries.get(name);
          if (!entry) return Effect.fail(new Error(`Unknown module: ${name}`));
          return manifestOf(name, entry).pipe(
            Effect.map((manifest) => {
              const paths = new Map([...entry.layouts].map(([path, engine]) => [engine, path]));

              return manifest.engines.map((descriptor): EngineInfo => {
                const layoutPath = paths.get(descriptor.name);

                return {
                  ...descriptor,
                  layout: entry.snapshot.keyboards.get(descriptor.name)?.layout ?? descriptor.keyboard.layout,
                  ...(layoutPath === undefined ? {} : { layoutPath }),
                };
              });
            }),
            // An unreadable manifest fails the module, as it would when the module started.
            Effect.tapError((cause) =>
              Effect.sync(() => {
                if (!entry.started) fail(entry, startupFailure(name, cause).error);
              }),
            ),
          );
        }),
      select: (name) =>
        Effect.gen(function* () {
          if (name !== undefined && !entries.has(name)) return yield* Effect.fail(new Error(`Unknown module: ${name}`));
          for (const [key, entry] of entries) entry.snapshot.enabled = key === name;
          if (name !== undefined) yield* ensure(name);
        }),
      whenReady,
      state: (name) => {
        const entry = get(name);
        return state(entry);
      },
      snapshot: (name) => entries.get(name)?.snapshot,
      registerContext: (name, context) => get(name).router.register(context),
      drainContext: (name, context) => get(name).router.drain(context),
      captureDrainContext: (name, context) => get(name).router.captureDrain(context),
      retireContext: (name, context, beforeReplay) => get(name).router.retire(context, beforeReplay),
      holdKeys: (name) => get(name).router.holdKeys(),
      keySink: (name, context) => get(name).router.sink(context),
      keyAsync: (name, context, event) => get(name).router.keyAsync(context, event),
      request: (name, request, ic) => get(name).router.request(request, ic),
    };
    return service;
  });
