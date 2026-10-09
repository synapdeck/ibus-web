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
import type { StorageState } from "@ibus-web/worker-host";
import { Connection, type ConnectionOptions, type CrashInfo, type Reply } from "../connection/connection.ts";
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
import { loadSettingsMetadata, settingsInstances } from "../settings/api.ts";
import { CoreConfig } from "./config.ts";
import { Logger, PanelEvents, SyncMailbox } from "./logging.ts";
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
}
export type ModuleEvent =
  | { readonly _tag: "state"; readonly module: string; readonly state: ModuleState }
  | { readonly _tag: "storage"; readonly module: string; readonly state: StorageState; readonly message: string };
export interface ModuleRegistryService {
  readonly events: Stream.Stream<ModuleEvent>;
  unload(name: string): Effect.Effect<void, Error>;
  /** Development aid: terminate the real connection and use normal crash recovery. */
  debugRestart(name: string): Effect.Effect<void, Error>;
  select(name: string | undefined): Effect.Effect<void, Error>;
  /** Reads and validates the module's manifest without starting its Worker. */
  engines(name: string): Effect.Effect<readonly EngineDescriptor[], Error>;
  ensure(name: string): Effect.Effect<void, Error>;
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
  // The module's settings instances: path to schema id.
  readonly instances: Map<string, string>;
  readonly watchers: Set<() => void>;
  crashes: SyncMailbox<{ crash: CrashInfo; at: number }>;
  lifetime: Scope.Closeable | undefined;
  lastState: ModuleState | undefined;
  origin: symbol;
  started: boolean;
  hasReady: boolean;
}
class InitializationRejected extends Error {}
// Host startup errors cross the public message boundary as text with these diagnostic labels.
const terminalStartup = (cause: Error): boolean =>
  cause instanceof InitializationRejected ||
  cause instanceof RangeError ||
  /\b(?:RuntimeAbiMismatch|ProtocolMismatch):|manifest \(memory bounds /.test(cause.message);
const keyboards = (manifest: ModuleManifest): Map<string, KeyboardPolicy> =>
  new Map(
    manifest.engines.map(({ name, keyboard }) => [
      name,
      { layout: keyboard.layout, passThrough: new Set(keyboard.passThrough.map((key) => keysymByName.get(key)!)) },
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
        events.enqueue({ _tag: "state", module: entry.snapshot.name, state: value });
      }
    };
    const notify = (entry: Entry) => {
      changed(entry);
      for (const watcher of entry.watchers) watcher();
    };
    const fail = (entry: Entry) => {
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
      const raw = options.loadManifest
        ? await options.loadManifest(url)
        : await fetch(url).then((response) => {
            if (!response.ok) throw new Error(`Manifest fetch failed: ${response.status}`);
            return response.json();
          });
      const manifest = Schema.decodeUnknownSync(ModuleManifest, { onExcessProperty: "error" })(raw);
      for (const engine of manifest.engines) validateKeyboard(engine.keyboard);
      if (manifest.protocol !== PROTOCOL_VERSION)
        throw new InitializationRejected(`ProtocolMismatch: page ${PROTOCOL_VERSION}, manifest ${manifest.protocol}`);

      const owner = distributions.get(manifest.name);
      if (owner !== undefined && owner !== name)
        throw new Error(`Distribution ${manifest.name} is already registered as ${owner}`);
      distributions.set(manifest.name, name);
      return manifest;
    };
    // Listing engines and starting the Worker share one read; a failed read is retried on the next use.
    const reads = new Map<string, Promise<ModuleManifest>>();
    const manifestOf = (name: string, entry: Entry): Effect.Effect<ModuleManifest, Error> =>
      Effect.suspend(() => {
        if (entry.snapshot.manifest) return Effect.succeed(entry.snapshot.manifest);

        let read = reads.get(name);
        if (!read) {
          read = readManifest(name).then(
            (manifest) => {
              reads.delete(name);
              entry.snapshot.manifest = manifest;
              entry.snapshot.keyboards = keyboards(manifest);
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
    const boot = (name: string, entry: Entry) =>
      Effect.gen(function* () {
        const lifetime = entry.lifetime!;
        const manifest = yield* manifestOf(name, entry);
        const metadata = yield* Effect.tryPromise({
          try: (signal) => loadSettingsMetadata(manifest, options.modules[name]!, options, signal),
          catch: asError,
        });

        if (settings.register)
          yield* Effect.tryPromise({
            try: async () => {
              await settings.register!(metadata);
            },
            catch: asError,
          });

        const instances = settingsInstances(metadata);
        entry.instances.clear();
        for (const { schemaId, path } of instances) entry.instances.set(path, schemaId);

        const initial = yield* Effect.tryPromise({
          try: () => settings.snapshot(instances),
          catch: asError,
        });
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
          (connection) =>
            Effect.sync(() => {
              if (entry.snapshot.connection === connection) entry.router.disconnect();
              connection.terminate();
            }),
          { interruptible: true },
        ).pipe(Scope.provide(lifetime));
        entry.origin = Symbol();
        entry.router.connect(connection);
        const reply = yield* Effect.tryPromise({
          try: () =>
            entry.router.request(
              new Init({
                version: PROTOCOL_VERSION,
                settings: instances.map(({ schemaId, path }) => ({ schemaId, path, values: initial[path] ?? {} })),
              }),
              0,
            ),
          catch: asError,
        });
        if (reply.ret < 0) return yield* Effect.fail(new InitializationRejected(`Init failed: ${reply.ret}`));
        yield* flushChanges(entry);
        entry.hasReady = true;
        entry.snapshot.status = "ready";
        notify(entry);
      });
    const launch = (name: string, entry: Entry) =>
      Effect.suspend(() => {
        const generation = entry.snapshot.generation;
        return boot(name, entry).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              if (!entry.snapshot.manifest || terminalStartup(cause)) {
                fail(entry);
                return;
              }
              // The connection's crash notification already owns this failed attempt.
              if (entry.snapshot.generation !== generation) return;
              const crash: CrashInfo = { reason: "load", message: cause.message };
              if (entry.snapshot.connection) entry.router.crash(crash);
              else {
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
        origin: Symbol(),
        started: false,
        hasReady: false,
        changes: new Map(),
        instances: new Map(),
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
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const entry of entries.values()) entry.router.dispose();
      }),
    );
    yield* settings.changes.pipe(
      Stream.runForEach((change) =>
        Effect.gen(function* () {
          for (const entry of entries.values()) {
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
          } else if (entry.snapshot.status === "failed" || entry.snapshot.status === "unloaded") {
            entry.watchers.delete(check);
            resume(Effect.fail(new Error(`Module ${name} ${entry.snapshot.status}`)));
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
    const ensure = (name: string): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        if (!entries.has(name)) return yield* Effect.fail(new Error(`Unknown module: ${name}`));
        const entry = get(name);
        entry.snapshot.enabled = true;
        if (!entry.started) {
          entry.started = true;
          entry.snapshot.status = "starting";
          yield* startLifetime(name, entry);
          notify(entry);
          yield* boot(name, entry).pipe(
            Effect.catch(() => Effect.sync(() => fail(entry))),
            Effect.forkIn(entry.lifetime!),
          );
        }
        yield* whenReady(name);
      });
    const service: ModuleRegistryService = {
      events: Stream.fromPubSub(pubsub),
      unload: (name) =>
        Effect.gen(function* () {
          const entry = entries.get(name);
          if (!entry) return yield* Effect.fail(new Error(`Unknown module: ${name}`));
          const lifetime = entry.lifetime;
          entry.lifetime = undefined;
          entry.snapshot.enabled = false;
          entry.snapshot.generation++;
          entry.router.dispose();
          entry.snapshot.status = "unloaded";
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
      engines: (name) =>
        Effect.suspend(() => {
          const entry = entries.get(name);
          if (!entry) return Effect.fail(new Error(`Unknown module: ${name}`));
          return manifestOf(name, entry).pipe(
            Effect.map((manifest) => manifest.engines),
            // An unreadable manifest fails the module, as it would when the module started.
            Effect.tapError(() =>
              Effect.sync(() => {
                if (!entry.started) fail(entry);
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
