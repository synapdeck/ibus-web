// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Clock, Context, Effect, Layer, Schema, Scope, Stream } from "effect";
import { EngineManifest, Init, SettingChanged, PROTOCOL_VERSION, type Request } from "@ibus-web/protocol";
import { transportLayout } from "@ibus-web/worker-host";
import { Connection, type ConnectionOptions, type CrashInfo, type Reply } from "../connection/connection.ts";
import { keysymByName } from "../keys/keysyms.generated.ts";
import { validateKeyboard } from "../keys/manifest.ts";
import {
  KeyRouter,
  type EngineSnapshot,
  type EngineState,
  type KeyConnection,
  type KeyContext,
} from "../router/keystroke.ts";
import type { AsyncKeyResult, KeySink } from "../router/replay.ts";
import { makeRestarter, type WaitForWriter } from "../router/restart.ts";
import { CoreConfig } from "./config.ts";
import { Logger, PanelEvents, SyncMailbox } from "./logging.ts";
import { SettingsSource, type SettingsChange } from "./settings.ts";
export interface EngineRegistryOptions {
  readonly hostUrl: URL;
  readonly runtimeUrl: URL;
  /** Public registry keys may differ from both manifest.name and manifest.engines. */
  readonly engines: Readonly<Record<string, URL>>;
  readonly storage?: "browser" | "none";
  /** Honor options.signal for partial resources; late returned connections are terminated by the registry. */
  readonly start?: (options: ConnectionOptions) => Promise<KeyConnection>;
  readonly loadManifest?: (url: URL) => Promise<unknown>;
  readonly waitForWriter?: WaitForWriter;
}
export interface EngineRegistryService {
  select(name: string | undefined): Effect.Effect<void, Error>;
  ensure(name: string): Effect.Effect<void, Error>;
  whenReady(name: string): Effect.Effect<void, Error>;
  state(name: string): EngineState;
  snapshot(name: string): EngineSnapshot | undefined;
  registerContext(name: string, context: KeyContext): () => void;
  drainContext(name: string, context: KeyContext): Promise<void>;
  retireContext(name: string, context: KeyContext, beforeReplay?: () => void): void;
  keySink(name: string, context: KeyContext): KeySink;
  keyAsync(name: string, context: KeyContext, event: KeyboardEvent): Promise<AsyncKeyResult>;
  request(name: string, request: Request, ic: number): Promise<Reply>;
}
export class EngineRegistry extends Context.Service<EngineRegistry, EngineRegistryService>()(
  "@ibus-web/core/EngineRegistry",
) {
  static layer(options: EngineRegistryOptions) {
    return Layer.effect(EngineRegistry, makeEngineRegistry(options));
  }
}
interface Entry {
  readonly snapshot: EngineSnapshot;
  readonly router: KeyRouter;
  readonly changes: Map<string, SettingsChange>;
  readonly watchers: Set<() => void>;
  readonly crashes: SyncMailbox<{ crash: CrashInfo; at: number }>;
  started: boolean;
  hasReady: boolean;
}
const error = (cause: unknown): Error => (cause instanceof Error ? cause : new Error(String(cause)));
class InitializationRejected extends Error {}
// Host startup errors cross the public message boundary as text with these diagnostic labels.
const terminalStartup = (cause: Error): boolean =>
  cause instanceof InitializationRejected ||
  cause instanceof RangeError ||
  /\b(?:RuntimeAbiMismatch|ProtocolMismatch):|manifest \(memory bounds /.test(cause.message);
export const makeEngineRegistry = (options: EngineRegistryOptions) =>
  Effect.gen(function* () {
    const config = yield* CoreConfig;
    const settings = yield* SettingsSource;
    const logger = yield* Logger;
    const panel = yield* PanelEvents;
    const scope = yield* Scope.Scope;
    const clock = yield* Clock.Clock;
    const entries = new Map<string, Entry>();
    const distributions = new Map<string, string>();
    const notify = (entry: Entry) => {
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
            yield* Effect.tryPromise({ try: () => entry.router.request(new SettingChanged(change), 0), catch: error });
        }
      });
    const boot = (name: string, entry: Entry) =>
      Effect.gen(function* () {
        if (!entry.snapshot.manifest) {
          const raw = yield* Effect.tryPromise({
            try: () =>
              options.loadManifest
                ? options.loadManifest(options.engines[name]!)
                : fetch(options.engines[name]!).then((response) => {
                    if (!response.ok) throw new Error(`Manifest fetch failed: ${response.status}`);
                    return response.json();
                  }),
            catch: error,
          });
          const manifest = yield* Effect.try({
            try: () => Schema.decodeUnknownSync(EngineManifest, { onExcessProperty: "error" })(raw),
            catch: error,
          });
          yield* Effect.try({ try: () => validateKeyboard(manifest.keyboard), catch: error });
          if (manifest.protocol !== PROTOCOL_VERSION)
            return yield* Effect.fail(
              new InitializationRejected(`ProtocolMismatch: page ${PROTOCOL_VERSION}, manifest ${manifest.protocol}`),
            );
          const owner = distributions.get(manifest.name);
          if (owner !== undefined && owner !== name)
            return yield* Effect.fail(new Error(`Distribution ${manifest.name} is already registered as ${owner}`));
          distributions.set(manifest.name, name);
          entry.snapshot.manifest = manifest;
          entry.snapshot.keyboard = manifest.keyboard;
          entry.snapshot.passThrough = new Set(manifest.keyboard.passThrough.map((key) => keysymByName.get(key)!));
        }
        const manifest = entry.snapshot.manifest;
        const connection = yield* Effect.acquireRelease(
          Effect.callback<KeyConnection, Error>((resume, signal) => {
            try {
              void (options.start ?? Connection.start)({
                hostUrl: options.hostUrl,
                runtimeUrl: options.runtimeUrl,
                manifestUrl: options.engines[name]!,
                storage: options.storage ?? "browser",
                budgetMs: config.budgetMs,
                hangMs: config.hangMs,
                layout: transportLayout({ ringBytes: config.ringBytes, slotBytes: config.slotBytes }),
                signal,
              }).then(
                (connection) => {
                  // An injected starter may ignore cancellation and resolve after scope closure.
                  if (signal.aborted) connection.terminate();
                  else resume(Effect.succeed(connection));
                },
                (cause) => resume(Effect.fail(error(cause))),
              );
            } catch (cause) {
              resume(Effect.fail(error(cause)));
            }
          }),
          (connection) =>
            Effect.sync(() => {
              if (entry.snapshot.connection === connection) entry.router.disconnect();
              connection.terminate();
            }),
          { interruptible: true },
        ).pipe(Scope.provide(scope));
        entry.router.connect(connection);
        const initial = yield* Effect.tryPromise({
          try: () => settings.snapshot(manifest.settingsSchemas),
          catch: error,
        });
        const reply = yield* Effect.tryPromise({
          try: () => entry.router.request(new Init({ version: PROTOCOL_VERSION, settings: initial }), 0),
          catch: error,
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
    for (const name of Object.keys(options.engines)) {
      const snapshot: EngineSnapshot = {
        name,
        status: "starting",
        enabled: false,
        generation: 0,
        connection: undefined,
        keyboard: { layout: "default", passThrough: [] },
        passThrough: new Set(),
      };
      const crashes = new SyncMailbox<{ crash: CrashInfo; at: number }>();
      const entry: Entry = {
        snapshot,
        crashes,
        started: false,
        hasReady: false,
        changes: new Map(),
        watchers: new Set(),
        router: new KeyRouter(snapshot, {
          replayLimit: config.replayLimit,
          enqueue: ({ ic, record }) => {
            if (record._tag === "Log") logger.enqueue({ engine: name, ic, record });
            else if (record._tag === "SettingWritten") settings.written(record);
          },
          hide: (ic) => panel.enqueue({ _tag: "hide", engine: name, ic }),
          error: (cause, ic) =>
            logger.enqueue({
              engine: name,
              ic,
              record: { _tag: "Log", level: 8, domain: "page-adapter", message: error(cause).message },
            }),
          crashed: (crash) => {
            if (!entry.hasReady) {
              snapshot.status = "failed";
              notify(entry);
            } else crashes.enqueue({ crash, at: clock.currentTimeMillisUnsafe() });
          },
        }),
      };
      entries.set(name, entry);
      yield* Effect.addFinalizer(() => Effect.sync(() => crashes.close()));
      const restarter = yield* makeRestarter(config.restart, options.waitForWriter);
      yield* crashes.take.pipe(
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
        Effect.forkScoped,
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
            if (
              !entry.snapshot.manifest?.settingsSchemas.includes(change.schemaId) ||
              entry.snapshot.status === "failed"
            )
              continue;
            entry.changes.set(`${change.schemaId}\0${change.key}`, change);
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
      if (!entry) throw new Error(`Unknown engine: ${name}`);
      return entry;
    };
    const whenReady = (name: string): Effect.Effect<void, Error> =>
      Effect.callback((resume) => {
        const entry = entries.get(name);
        if (!entry) {
          resume(Effect.fail(new Error(`Unknown engine: ${name}`)));
          return;
        }
        const check = () => {
          if (entry.snapshot.status === "ready") {
            entry.watchers.delete(check);
            resume(Effect.void);
          } else if (entry.snapshot.status === "failed") {
            entry.watchers.delete(check);
            resume(Effect.fail(new Error(`Engine ${name} failed`)));
          }
        };
        entry.watchers.add(check);
        check();
        return Effect.sync(() => {
          entry.watchers.delete(check);
        });
      });
    const ensure = (name: string): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        if (!entries.has(name)) return yield* Effect.fail(new Error(`Unknown engine: ${name}`));
        const entry = get(name);
        entry.snapshot.enabled = true;
        if (!entry.started) {
          entry.started = true;
          yield* boot(name, entry).pipe(
            Effect.catch(() => Effect.sync(() => fail(entry))),
            Effect.forkIn(scope),
          );
        }
        yield* whenReady(name);
      });
    const service: EngineRegistryService = {
      ensure,
      select: (name) =>
        Effect.gen(function* () {
          if (name !== undefined && !entries.has(name)) return yield* Effect.fail(new Error(`Unknown engine: ${name}`));
          for (const [key, entry] of entries) entry.snapshot.enabled = key === name;
          if (name !== undefined) yield* ensure(name);
        }),
      whenReady,
      state: (name) => {
        const entry = get(name);
        return entry.snapshot.status === "ready" && entry.router.busy ? "busy" : entry.snapshot.status;
      },
      snapshot: (name) => entries.get(name)?.snapshot,
      registerContext: (name, context) => get(name).router.register(context),
      drainContext: (name, context) => get(name).router.drain(context),
      retireContext: (name, context, beforeReplay) => get(name).router.retire(context, beforeReplay),
      keySink: (name, context) => get(name).router.sink(context),
      keyAsync: (name, context, event) => get(name).router.keyAsync(context, event),
      request: (name, request, ic) => get(name).router.request(request, ic),
    };
    return service;
  });
