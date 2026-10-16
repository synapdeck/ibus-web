// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it, vi } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Logger as EffectLogger, References, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { booleanVariant, CreateEngine, stringVariant, type ModuleManifest, type Request } from "@ibus-web/protocol";
import { makeModuleRegistry } from "../../../src/services/modules.ts";
import { ConnectionFailed, PrepareFailed } from "../../../src/connection/connection.ts";
import { PrepareEngineError, RuntimeAbiMismatch } from "../../../src/errors.ts";
import { CoreConfig } from "../../../src/services/config.ts";
import { SettingsSource } from "../../../src/services/settings.ts";
import { Logger, PanelEvents, glibLevel } from "../../../src/services/logging.ts";
import { FakeConnection, fixture, key } from "../../shared/router.ts";
const dataPath = `/nix/store/${"a".repeat(32)}-test`;
const manifest: ModuleManifest = {
  name: "test",
  version: "1",
  license: "MIT",
  runtimeAbi: 1,
  runtimeIdentity: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  protocol: 1,
  module: { url: "engine.so", size: 1 },
  memory: 65536,
  threads: 0,
  data: [{ storePath: dataPath, url: "data.tar", size: 0, encoding: "identity" }],
  settingsSchemaDir: `${dataPath}/schemas`,
  engines: [{ name: "test", displayName: "test", languages: [], keyboard: { layout: "us", passThrough: [] } }],
  settingsSchemas: ["settings"],
  settingsMetadata: { url: "settings.json", size: 1 },
};
const metadata = { schemas: [{ id: "settings", paths: ["/settings/"], keys: [] }] };
const url = new URL("https://example.test/");
const services = Layer.mergeAll(CoreConfig.Default, SettingsSource.layer(), Logger.Default, PanelEvents.Default);
const emptyReply = { ret: 0, outSeq: 0, records: [] };

it.effect("registry restarts with current settings and leaves contexts uncreated until next focus", () =>
  Effect.gen(function* () {
    const settings = yield* SettingsSource;
    const started: FakeConnection[] = [];
    const requests: Request[] = [];
    const boots = yield* Deferred.make<void>();
    const registry = yield* makeModuleRegistry({
      hostUrl: url,
      runtimeUrl: url,
      modules: { test: url },
      loadManifest: async () => manifest,
      loadMetadata: async () => metadata,
      waitForWriter: () => Effect.void,
      start: async () => {
        const connection = new FakeConnection();
        connection.requestAsync = async (request) => {
          requests.push(request);
          return emptyReply;
        };
        started.push(connection);
        if (started.length === 2) Deferred.doneUnsafe(boots, Effect.void);
        return connection;
      },
    });
    yield* registry.select("test");
    const f = fixture();
    f.context.generation = registry.snapshot("test")!.generation;
    registry.registerContext("test", f.context);
    expect(registry.keySink("test", f.context).key(key("a"))).toBe("consumed");
    settings.written({
      schemaId: "settings",
      path: "/settings/",
      key: "mode",
      value: stringVariant("new"),
    });
    started[0]!.crash({ reason: "worker", message: "stop", storage: "read-only" });
    expect(f.context.ready).toBe(false);
    yield* Deferred.await(boots);
    // Join the restarted Init explicitly, without elapsed-time sleeps.
    yield* registry.whenReady("test");
    expect(registry.state("test")).toBe("ready");
    expect(requests.filter((r) => r._tag === "Init")).toMatchObject([
      { settings: [{ schemaId: "settings", path: "/settings/", values: {} }] },
      { settings: [{ schemaId: "settings", path: "/settings/", values: { mode: { value: { value: "new" } } } }] },
    ]);
    expect(requests.some((r) => r._tag === "CreateEngine")).toBe(false);
    expect(registry.keySink("test", f.context).key(key("a"))).toBe("passthrough");
  }).pipe(Effect.provide(services)),
);

it.effect("registry tells Init the user data is read-only once the host reported so, and writable otherwise", () =>
  Effect.gen(function* () {
    const inits: Request[] = [];
    let starts = 0;
    const registry = yield* makeModuleRegistry({
      hostUrl: url,
      runtimeUrl: url,
      modules: { test: url },
      loadManifest: async () => manifest,
      loadMetadata: async () => metadata,
      waitForWriter: () => Effect.void,
      start: async (options) => {
        if (starts++ === 0) options.onStorage?.({ state: "read-only", message: "another host writes" });
        const connection = new FakeConnection();
        connection.requestAsync = async (request) => {
          if (request._tag === "Init") inits.push(request);
          return emptyReply;
        };
        return connection;
      },
    });
    yield* registry.select("test");
    yield* registry.debugRestart("test");
    expect(inits).toMatchObject([{ userDataWritable: false }, { userDataWritable: true }]);
  }).pipe(Effect.provide(services)),
);

it.effect("registry validates keyboard names before starting a Worker", () =>
  Effect.gen(function* () {
    let started = false;
    const registry = yield* makeModuleRegistry({
      hostUrl: url,
      runtimeUrl: url,
      modules: { test: url },
      loadManifest: async () => ({
        ...manifest,
        engines: [{ ...manifest.engines[0]!, keyboard: { layout: "us", passThrough: ["NotAKeysym"] } }],
      }),
      start: async () => {
        started = true;
        return new FakeConnection();
      },
    });
    expect((yield* Effect.exit(registry.select("test")))._tag).toBe("Failure");
    expect(started).toBe(false);
    expect(registry.state("test")).toBe("failed");
  }).pipe(Effect.provide(services)),
);

it.effect("registry lists a module's engines without starting its Worker, and starts it on the same read", () =>
  Effect.gen(function* () {
    let reads = 0,
      starts = 0;
    const registry = yield* makeModuleRegistry({
      hostUrl: url,
      runtimeUrl: url,
      modules: { test: url },
      loadMetadata: async () => metadata,
      loadManifest: async () => {
        reads++;
        return { ...manifest, engines: [...manifest.engines, { ...manifest.engines[0]!, name: "second" }] };
      },
      start: async () => {
        starts++;
        const connection = new FakeConnection();
        connection.requestAsync = async () => emptyReply;
        return connection;
      },
    });
    expect((yield* registry.engines("test")).map((engine) => engine.name)).toEqual(["test", "second"]);
    expect(starts).toBe(0);
    expect(registry.state("test")).toBe("starting");
    yield* registry.select("test");
    expect(starts).toBe(1);
    expect(reads).toBe(1);
    expect([...registry.snapshot("test")!.keyboards.keys()]).toEqual(["test", "second"]);
    expect((yield* Effect.exit(registry.engines("missing")))._tag).toBe("Failure");
  }).pipe(Effect.provide(services)),
);

it.effect("an unreadable manifest fails the module when its engines are listed", () =>
  Effect.gen(function* () {
    const registry = yield* makeModuleRegistry({
      hostUrl: url,
      runtimeUrl: url,
      modules: { test: url },
      loadManifest: async () => ({ ...manifest, engines: [] }),
      start: async () => new FakeConnection(),
    });
    expect((yield* Effect.exit(registry.engines("test")))._tag).toBe("Failure");
    expect(registry.state("test")).toBe("failed");
  }).pipe(Effect.provide(services)),
);

it.effect(
  "settings and panel streams publish after synchronous enqueue, and logger maps GLib levels with annotations",
  () =>
    Effect.gen(function* () {
      const settings = yield* SettingsSource;
      const panel = yield* PanelEvents;
      const logger = yield* Logger;
      const setting = yield* settings.changes.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
      const panelEvent = yield* panel.events.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
      yield* Effect.yieldNow;
      settings.written({
        schemaId: "settings",
        path: "/settings/",
        key: "x",
        value: booleanVariant(true),
      });
      panel.enqueue({ _tag: "hide", module: "test", ic: 1 });
      expect((yield* Fiber.join(setting))[0]?.key).toBe("x");
      expect((yield* Fiber.join(panelEvent))[0]?._tag).toBe("hide");
      expect(
        yield* Effect.promise(() => settings.snapshot([{ schemaId: "settings", path: "/settings/" }])),
      ).toHaveProperty(["/settings/", "x"]);
      expect([4, 8, 16, 32, 64, 128].map(glibLevel)).toEqual(["Error", "Error", "Warn", "Info", "Info", "Debug"]);
      const logged = yield* Deferred.make<void>();
      const lines: unknown[] = [];
      const custom = EffectLogger.make((options) => {
        lines.push({ logLevel: options.logLevel, annotations: options.fiber.getRef(References.CurrentLogAnnotations) });
        Deferred.doneUnsafe(logged, Effect.void);
      });
      // The service owns the logging fiber and inherits the provided logger.
      yield* Effect.gen(function* () {
        const log = yield* Logger;
        log.enqueue({ module: "test", ic: 3, record: { _tag: "Log", level: 16, domain: "glib", message: "notice" } });
        expect(lines).toEqual([]);
        yield* Deferred.await(logged);
        expect(lines[0]).toMatchObject({
          logLevel: "Warn",
          annotations: { module: "test", inputContext: 3, domain: "glib" },
        });
      }).pipe(
        Effect.provide(Layer.fresh(Logger.Default)),
        Effect.provide(EffectLogger.layer([custom])),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      );
      void logger;
    }).pipe(Effect.provide(services)),
);

it.effect("the third crash fails the registry and disables its existing key sinks", () =>
  Effect.gen(function* () {
    const connections: FakeConnection[] = [];
    const registry = yield* makeModuleRegistry({
      hostUrl: url,
      runtimeUrl: url,
      modules: { test: url },
      loadManifest: async () => manifest,
      loadMetadata: async () => metadata,
      waitForWriter: () => Effect.void,
      start: async () => {
        const c = new FakeConnection();
        c.requestAsync = async () => emptyReply;
        connections.push(c);
        return c;
      },
    });
    yield* registry.select("test");
    const f = fixture();
    registry.registerContext("test", f.context);
    const sink = registry.keySink("test", f.context);
    connections[0]!.crash({ reason: "worker", message: "one", storage: "read-only" });
    yield* registry.whenReady("test");
    connections[1]!.crash({ reason: "worker", message: "two", storage: "read-only" });
    const ready = yield* registry.whenReady("test").pipe(Effect.forkScoped);
    yield* TestClock.adjust(250);
    yield* Fiber.join(ready);
    connections[2]!.crash({ reason: "worker", message: "three", storage: "read-only" });
    expect((yield* Effect.exit(registry.whenReady("test")))._tag).toBe("Failure");
    expect(registry.state("test")).toBe("failed");
    expect(sink.key(key("a"))).toBe("passthrough");
    expect(connections).toHaveLength(3);
  }).pipe(Effect.provide(services)),
);

it.effect(
  "public alias, distribution writer lock, and factory name remain distinct; a stuck lock leaves failed state",
  () =>
    Effect.gen(function* () {
      const c = new FakeConnection();
      const sent: Request[] = [];
      c.requestAsync = async (request) => {
        sent.push(request);
        return emptyReply;
      };
      const locks: string[] = [];
      const registry = yield* makeModuleRegistry({
        hostUrl: url,
        runtimeUrl: url,
        modules: { alias: url },
        loadMetadata: async () => metadata,
        loadManifest: async () => ({
          ...manifest,
          name: "distribution",
          engines: [{ ...manifest.engines[0]!, name: "factory" }],
        }),
        start: async () => c,
        waitForWriter: (name) => {
          locks.push(name);
          return Effect.never;
        },
      });
      yield* registry.select("alias");
      expect(registry.snapshot("alias")!.manifest!.engines.map((engine) => engine.name)).toEqual(["factory"]);
      yield* Effect.promise(() =>
        registry.request(
          "alias",
          new CreateEngine({ name: registry.snapshot("alias")!.manifest!.engines[0]!.name }),
          1,
        ),
      );
      expect(sent.at(-1)).toMatchObject({ _tag: "CreateEngine", name: "factory" });
      c.crash();
      const failed = yield* registry.whenReady("alias").pipe(Effect.exit, Effect.forkScoped);
      yield* TestClock.adjust(10000);
      expect((yield* Fiber.join(failed))._tag).toBe("Failure");
      expect(locks).toEqual(["distribution"]);
      expect(registry.state("alias")).toBe("failed");
    }).pipe(Effect.provide(services)),
);

it.effect("a failed relaunch consumes the next restart step without losing registered contexts", () =>
  Effect.gen(function* () {
    const connections: FakeConnection[] = [];
    const settings = yield* SettingsSource;
    const requests: Request[] = [];
    let attempts = 0;
    const rejected = yield* Deferred.make<void>();
    const registry = yield* makeModuleRegistry({
      hostUrl: url,
      runtimeUrl: url,
      modules: { test: url },
      loadManifest: async () => manifest,
      loadMetadata: async () => metadata,
      waitForWriter: () => Effect.void,
      start: async () => {
        attempts++;
        if (attempts === 2) {
          Deferred.doneUnsafe(rejected, Effect.void);
          throw new Error("transient load");
        }
        const c = new FakeConnection();
        c.requestAsync = async (request) => {
          requests.push(request);
          return emptyReply;
        };
        connections.push(c);
        return c;
      },
    });
    yield* registry.select("test");
    const f = fixture();
    registry.registerContext("test", f.context);
    connections[0]!.crash();
    yield* Deferred.await(rejected);
    settings.written({
      schemaId: "settings",
      path: "/settings/",
      key: "latest",
      value: booleanVariant(true),
    });
    const ready = yield* registry.whenReady("test").pipe(Effect.forkScoped);
    yield* TestClock.adjust(250);
    yield* Fiber.join(ready);
    expect(attempts).toBe(3);
    expect(requests.filter((r) => r._tag === "Init").at(-1)).toMatchObject({
      settings: [{ schemaId: "settings", path: "/settings/", values: { latest: { value: { value: true } } } }],
    });
    f.context.generation = registry.snapshot("test")!.generation;
    f.context.ready = true;
    expect(registry.keySink("test", f.context).key(key("a"))).toBe("consumed");
  }).pipe(Effect.provide(services)),
);

it.effect("initial startup failure is terminal, without scheduling relaunch", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const registry = yield* makeModuleRegistry({
      hostUrl: url,
      runtimeUrl: url,
      modules: { test: url },
      loadManifest: async () => manifest,
      loadMetadata: async () => metadata,
      start: async () => {
        attempts++;
        throw new Error("network failure");
      },
    });
    expect((yield* Effect.exit(registry.select("test")))._tag).toBe("Failure");
    yield* TestClock.adjust(10000);
    expect(registry.state("test")).toBe("failed");
    expect(attempts).toBe(1);
  }).pipe(Effect.provide(services)),
);

it.effect("repeated transient relaunch failures reach the crash cutoff", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const c = new FakeConnection();
    c.requestAsync = async () => emptyReply;
    const rejected = yield* Deferred.make<void>();
    const registry = yield* makeModuleRegistry({
      hostUrl: url,
      runtimeUrl: url,
      modules: { test: url },
      loadManifest: async () => manifest,
      loadMetadata: async () => metadata,
      waitForWriter: () => Effect.void,
      start: async () => {
        if (++attempts > 1) {
          Deferred.doneUnsafe(rejected, Effect.void);
          throw new Error("network failure");
        }
        return c;
      },
    });
    yield* registry.select("test");
    c.crash();
    yield* Deferred.await(rejected);
    const failed = yield* registry.whenReady("test").pipe(Effect.exit, Effect.forkScoped);
    yield* TestClock.adjust(250);
    expect((yield* Fiber.join(failed))._tag).toBe("Failure");
    expect(attempts).toBe(3);
    expect(registry.state("test")).toBe("failed");
  }).pipe(Effect.provide(services)),
);

it.effect("runtime incompatibility is terminal even during relaunch", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const c = new FakeConnection();
    c.requestAsync = async () => emptyReply;
    const registry = yield* makeModuleRegistry({
      hostUrl: url,
      runtimeUrl: url,
      modules: { test: url },
      loadManifest: async () => manifest,
      loadMetadata: async () => metadata,
      waitForWriter: () => Effect.void,
      start: async () => {
        if (++attempts > 1)
          throw new ConnectionFailed({
            reason: "load",
            message: "RuntimeAbiMismatch: manifest 1, runtime 2",
            refused: "RuntimeAbiMismatch",
          });
        return c;
      },
    });
    yield* registry.select("test");
    c.crash();
    expect(yield* Effect.flip(registry.whenReady("test"))).toBeInstanceOf(RuntimeAbiMismatch);
    yield* TestClock.adjust(10000);
    expect(attempts).toBe(2);
  }).pipe(Effect.provide(services)),
);

it.effect("the in-memory settings layer ignores writes after its scope closes", () =>
  Effect.gen(function* () {
    const closed = yield* Effect.gen(function* () {
      return yield* SettingsSource;
    }).pipe(Effect.provide(SettingsSource.layer()));
    closed.written({
      schemaId: "settings",
      path: "/settings/",
      key: "late",
      value: booleanVariant(true),
    });
    expect(yield* Effect.promise(() => closed.snapshot([{ schemaId: "settings", path: "/settings/" }]))).toEqual({
      "/settings/": {},
    });
  }),
);

it.effect("read-only queue overflow restarts without waiting for a writer lock", () =>
  Effect.gen(function* () {
    const connections: FakeConnection[] = [];
    let locks = 0;
    const registry = yield* makeModuleRegistry({
      hostUrl: url,
      runtimeUrl: url,
      modules: { test: url },
      loadManifest: async () => manifest,
      loadMetadata: async () => metadata,
      waitForWriter: () => {
        locks++;
        return Effect.fail(new Error("must skip read-only lock"));
      },
      start: async () => {
        const c = new FakeConnection();
        c.requestAsync = async () => emptyReply;
        c.terminate = (crash) =>
          c.crash({ ...(crash ?? { reason: "worker", message: "terminate" }), storage: "read-only" });
        connections.push(c);
        return c;
      },
    });
    yield* registry.select("test");
    const f = fixture();
    registry.registerContext("test", f.context);
    connections[0]!.outcome = { _tag: "pending" };
    const sink = registry.keySink("test", f.context);
    for (let i = 0; i < 65; i++) expect(sink.key(key("a"))).toBe("consumed");
    yield* registry.whenReady("test");
    expect(locks).toBe(0);
    expect(connections).toHaveLength(2);
    expect(f.calls.filter((c) => c.startsWith("replay:"))).toHaveLength(65);
    expect(f.calls.filter((c) => c === "clear")).toHaveLength(1);
  }).pipe(Effect.provide(services)),
);

for (const phase of ["initial", "restart"] as const) {
  it.effect(`scope closure cancels ${phase} startup and cleans up an injected late connection`, () => {
    const late = new FakeConnection();
    let resolveStart: ((connection: FakeConnection) => void) | undefined;
    let signal: AbortSignal | undefined;
    const pending = new Promise<FakeConnection>((resolve) => {
      resolveStart = resolve;
    });
    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const entered = yield* Deferred.make<void>();
      const first = new FakeConnection();
      first.requestAsync = async () => emptyReply;
      let attempts = 0;
      const registry = yield* makeModuleRegistry({
        hostUrl: url,
        runtimeUrl: url,
        modules: { test: url },
        loadManifest: async () => manifest,
        loadMetadata: async () => metadata,
        waitForWriter: () => Effect.void,
        start: (options) => {
          if (phase === "restart" && attempts++ === 0) return Promise.resolve(first);
          signal = options.signal;
          Deferred.doneUnsafe(entered, Effect.void);
          return pending;
        },
      }).pipe(Scope.provide(scope));
      if (phase === "restart") {
        yield* registry.select("test");
        first.crash({ reason: "worker", message: "restart", storage: "read-only" });
      } else yield* registry.select("test").pipe(Effect.forkIn(scope));
      yield* Deferred.await(entered);
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped);
      yield* TestClock.adjust(0);
      expect(closing.pollUnsafe()).toMatchObject({ _tag: "Success" });
      expect(signal?.aborted).toBe(true);
      expect(late.terminated).toBe(false);
      resolveStart!(late);
      yield* Effect.promise(() => pending);
      expect(late.terminated).toBe(true);
      expect(late.sent).toEqual([]);
      expect(registry.snapshot("test")!.connection).toBeUndefined();
      expect(registry.state("test")).toBe("failed");
    }).pipe(Effect.ensuring(Effect.sync(() => resolveStart?.(late))), Effect.provide(services));
  });
}

it.effect(
  "ensure starts and enables multiple identities without duplicating workers, while select stays exclusive",
  () =>
    Effect.gen(function* () {
      const starts: string[] = [];
      const registry = yield* makeModuleRegistry({
        hostUrl: url,
        runtimeUrl: url,
        modules: { a: new URL("a", url), b: new URL("b", url) },
        loadMetadata: async () => metadata,
        loadManifest: async (u) => ({ ...manifest, name: u.pathname.slice(1) }),
        start: async (options) => {
          starts.push(options.manifestUrl.pathname);
          const c = new FakeConnection();
          c.requestAsync = async () => emptyReply;
          return c;
        },
      });
      yield* registry.ensure("a");
      yield* registry.ensure("b");
      yield* registry.ensure("a");
      expect(starts).toEqual(["/a", "/b"]);
      expect(registry.snapshot("a")!.enabled).toBe(true);
      expect(registry.snapshot("b")!.enabled).toBe(true);
      yield* registry.select("a");
      expect(registry.snapshot("b")!.enabled).toBe(false);
    }).pipe(Effect.provide(services)),
);

it.effect("unload cancels a pending boot, rejects its waiter and permits a fresh selection", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let resolve!: (c: FakeConnection) => void;
    let signal: AbortSignal | undefined;
    const late = new FakeConnection();
    const fresh = new FakeConnection();
    fresh.requestAsync = async () => emptyReply;
    let starts = 0;
    const registry = yield* makeModuleRegistry({
      hostUrl: url,
      runtimeUrl: url,
      modules: { test: url },
      loadManifest: async () => manifest,
      loadMetadata: async () => metadata,
      start: (options) => {
        if (++starts > 1) return Promise.resolve(fresh);
        signal = options.signal;
        Deferred.doneUnsafe(entered, Effect.void);
        return new Promise<FakeConnection>((done) => {
          resolve = done;
        });
      },
    });
    const selecting = yield* registry.select("test").pipe(Effect.exit, Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* registry.unload("test");
    expect(signal?.aborted).toBe(true);
    expect((yield* Fiber.join(selecting))._tag).toBe("Failure");
    expect(registry.state("test")).toBe("unloaded");
    resolve(late);
    yield* Effect.promise(() => Promise.resolve());
    expect(late.terminated).toBe(true);
    yield* registry.select("test");
    expect(starts).toBe(2);
    expect(registry.snapshot("test")!.connection).toBe(fresh);
  }).pipe(Effect.provide(services)),
);

it.effect("unload cancels pending async owners without replay and stops scheduled restart", () =>
  Effect.gen(function* () {
    let starts = 0;
    const connection = new FakeConnection();
    connection.requestAsync = async () => emptyReply;
    const registry = yield* makeModuleRegistry({
      hostUrl: url,
      runtimeUrl: url,
      modules: { test: url },
      loadManifest: async () => manifest,
      loadMetadata: async () => metadata,
      start: async () => {
        starts++;
        return connection;
      },
      waitForWriter: () => Effect.never,
    });
    yield* registry.select("test");
    const f = fixture();
    registry.registerContext("test", f.context);
    connection.requestAsync = FakeConnection.prototype.requestAsync.bind(connection);
    const event = Object.assign(key("a"), { preventDefault() {}, stopPropagation() {} });
    const pending = registry.keyAsync("test", f.context, event);
    yield* registry.unload("test");
    expect(yield* Effect.promise(() => pending)).toBe("cancelled");
    expect(f.calls.some((value) => value.startsWith("replay:"))).toBe(false);
    yield* TestClock.adjust(10000);
    expect(starts).toBe(1);
    expect(connection.terminated).toBe(true);
  }).pipe(Effect.provide(services)),
);

it.effect("unload interrupts a restart wait without resurrecting the engine", () =>
  Effect.gen(function* () {
    let starts = 0;
    const waiting = yield* Deferred.make<void>();
    const connection = new FakeConnection();
    connection.requestAsync = async () => emptyReply;
    const registry = yield* makeModuleRegistry({
      hostUrl: url,
      runtimeUrl: url,
      modules: { test: url },
      loadManifest: async () => manifest,
      loadMetadata: async () => metadata,
      start: async () => {
        starts++;
        return connection;
      },
      waitForWriter: () => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* registry.select("test");
    connection.crash();
    yield* Deferred.await(waiting);
    yield* registry.unload("test");
    yield* TestClock.adjust(10000);
    expect(starts).toBe(1);
    expect(registry.state("test")).toBe("unloaded");
  }).pipe(Effect.provide(services)),
);

it.effect(
  "registry prepares an engine's own data once per Worker, reports its progress, and tries a failed install again",
  () =>
    Effect.gen(function* () {
      const lazyPath = `/nix/store/${"b".repeat(32)}-lazy`;
      const lazy: ModuleManifest = {
        ...manifest,
        data: [...manifest.data, { storePath: lazyPath, url: "lazy.tar", size: 10, encoding: "identity" }],
        engines: [...manifest.engines, { ...manifest.engines[0]!, name: "lazy", data: [lazyPath] }],
      };
      const started: FakeConnection[] = [];
      const restarted = yield* Deferred.make<void>();
      let failures = 1;
      const registry = yield* makeModuleRegistry({
        hostUrl: url,
        runtimeUrl: url,
        modules: { test: url },
        loadManifest: async () => lazy,
        loadMetadata: async () => metadata,
        waitForWriter: () => Effect.void,
        start: async () => {
          const connection = new FakeConnection();
          connection.requestAsync = async () => emptyReply;
          connection.prepareWith = async (_, progress) => {
            progress?.(4, 10);
            if (failures-- > 0) throw new PrepareFailed("no space left");
            progress?.(10, 10);
          };
          started.push(connection);
          if (started.length === 2) Deferred.doneUnsafe(restarted, Effect.void);
          return connection;
        },
      });
      const installs = yield* registry.events.pipe(
        Stream.filter((event) => event._tag === "install"),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* registry.prepare("test", "test");
      expect(started, "Workers started for an engine without data of its own").toHaveLength(0);
      expect(registry.isPrepared("test", "test"), "an engine without data of its own").toBe(true);
      expect((yield* Effect.flip(registry.prepare("test", "missing"))).message).toBe(
        "Unknown engine: missing in module test",
      );

      const failed = yield* Effect.flip(registry.prepare("test", "lazy"));
      expect(failed).toBeInstanceOf(PrepareEngineError);
      expect(failed).toMatchObject({ module: "test", engine: "lazy", diagnostic: "no space left" });
      expect(registry.snapshot("test")!.enabled, "a module prepared but not selected").toBe(false);
      expect(registry.isPrepared("test", "lazy"), "after a failed install").toBe(false);
      yield* registry.prepare("test", "lazy");
      expect(registry.isPrepared("test", "lazy"), "once installed").toBe(true);
      yield* registry.prepare("test", "lazy");
      expect(started[0]!.prepared).toEqual(["lazy", "lazy"]);

      started[0]!.crash({ reason: "worker", message: "stop" });
      yield* Deferred.await(restarted);
      yield* registry.whenReady("test");
      expect(registry.isPrepared("test", "lazy"), "in the restarted Worker").toBe(false);
      yield* registry.prepare("test", "lazy");
      expect(started[1]!.prepared, "the restarted Worker's").toEqual(["lazy"]);
      expect([...(yield* Fiber.join(installs))].map(({ bytes, total }) => [bytes, total])).toEqual([
        [4, 10],
        [4, 10],
        [10, 10],
        [4, 10],
        [10, 10],
      ]);
    }).pipe(Effect.provide(services)),
);

const persistRegistry = (started: FakeConnection[]) =>
  makeModuleRegistry({
    hostUrl: url,
    runtimeUrl: url,
    modules: { test: url },
    loadManifest: async () => manifest,
    loadMetadata: async () => metadata,
    waitForWriter: () => Effect.void,
    start: async () => {
      const connection = new FakeConnection();
      connection.requestAsync = async (request, ic) => {
        connection.sent.push({ mode: "async", request, ic });
        return emptyReply;
      };
      started.push(connection);
      return connection;
    },
  });
const persists = (connection: FakeConnection) =>
  connection.sent.filter(({ request }) => request._tag === "Persist").map(({ mode, ic }) => ({ mode, ic }));
// The requests that end a Worker's engines, in the order sent.
const endings = (connection: FakeConnection) =>
  connection.sent
    .filter(({ request }) => request._tag === "Persist" || request._tag === "Shutdown")
    .map(({ mode, request }) => [mode, request._tag]);

it.effect(
  "a ready Worker persists, then shuts down, each waiting up to hangMs, before unload or the registry's end terminates it",
  () =>
    Effect.gen(function* () {
      const started: FakeConnection[] = [];
      const scope = yield* Scope.make();
      const registry = yield* persistRegistry(started).pipe(Scope.provide(scope));
      yield* registry.select("test");
      started[0]!.duringSync = () => expect(started[0]!.terminated).toBe(false);
      yield* registry.unload("test");
      expect(endings(started[0]!)).toEqual([
        ["sync", "Persist"],
        ["sync", "Shutdown"],
      ]);
      expect(started[0]!.budgets).toEqual([CoreConfig.defaults.hangMs, CoreConfig.defaults.hangMs]);
      expect(started[0]!.terminated).toBe(true);

      yield* registry.select("test");
      started[1]!.duringSync = () => expect(started[1]!.terminated).toBe(false);
      yield* Scope.close(scope, Exit.void);
      expect(endings(started[1]!)).toEqual([
        ["sync", "Persist"],
        ["sync", "Shutdown"],
      ]);
      expect(started[1]!.terminated).toBe(true);
    }).pipe(Effect.provide(services)),
);

it.effect("a Worker busy at unload is sent Persist and Shutdown behind its request", () =>
  Effect.gen(function* () {
    const started: FakeConnection[] = [];
    const registry = yield* persistRegistry(started);
    yield* registry.select("test");
    const connection = started[0]!;
    const f = fixture();
    f.context.generation = registry.snapshot("test")!.generation;
    registry.registerContext("test", f.context);
    connection.requestAsync = FakeConnection.prototype.requestAsync.bind(connection);
    const event = Object.assign(key("a"), { preventDefault() {}, stopPropagation() {} });
    void registry.keyAsync("test", f.context, event);
    yield* registry.unload("test");
    expect(
      connection.sent.filter(({ request }) => request._tag !== "Init").map(({ mode, request }) => [mode, request._tag]),
    ).toEqual([
      ["async", "ProcessKeyEvent"],
      ["async", "Persist"],
      ["async", "Shutdown"],
    ]);
  }).pipe(Effect.provide(services)),
);

it.effect("a Worker busy with a request persists after it", () =>
  Effect.gen(function* () {
    const started: FakeConnection[] = [];
    const registry = yield* persistRegistry(started);
    yield* registry.select("test");
    const connection = started[0]!;
    const f = fixture();
    f.context.generation = registry.snapshot("test")!.generation;
    registry.registerContext("test", f.context);
    connection.requestAsync = FakeConnection.prototype.requestAsync.bind(connection);
    const event = Object.assign(key("a"), { preventDefault() {}, stopPropagation() {} });
    void registry.keyAsync("test", f.context, event);
    registry.persist();
    expect(
      connection.sent.filter(({ request }) => request._tag !== "Init").map(({ mode, request }) => [mode, request._tag]),
    ).toEqual([
      ["async", "ProcessKeyEvent"],
      ["async", "Persist"],
    ]);
  }).pipe(Effect.provide(services)),
);

it.effect("the page going away has every ready Worker persist, waiting at pagehide, until the registry ends", () =>
  Effect.gen(function* () {
    const page = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("window", page);
    vi.stubGlobal("document", document);
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()));

    const started: FakeConnection[] = [];
    const scope = yield* Scope.make();
    const registry = yield* persistRegistry(started).pipe(Scope.provide(scope));
    page.dispatchEvent(new Event("pagehide"));
    page.dispatchEvent(new Event("beforeunload"));
    yield* registry.select("test");
    const connection = started[0]!;
    expect(persists(connection), "before the Worker was ready").toEqual([]);

    document.dispatchEvent(new Event("visibilitychange"));
    expect(persists(connection), "while visible").toEqual([]);
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    page.dispatchEvent(new Event("beforeunload"));
    // The navigation the page is leaving for takes long enough for the requests sent so far to be answered.
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
    page.dispatchEvent(new Event("pagehide"));
    expect(persists(connection)).toEqual([
      { mode: "async", ic: 0 },
      { mode: "async", ic: 0 },
      { mode: "sync", ic: 0 },
    ]);
    expect(connection.budgets).toEqual([CoreConfig.defaults.hangMs]);

    yield* registry.unload("test");
    const sent = persists(connection).length;
    page.dispatchEvent(new Event("beforeunload"));
    expect(persists(connection), "with no Worker running").toHaveLength(sent);

    yield* registry.select("test");
    yield* Scope.close(scope, Exit.void);
    const after = persists(started[1]!).length;
    page.dispatchEvent(new Event("pagehide"));
    page.dispatchEvent(new Event("beforeunload"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(persists(started[1]!)).toHaveLength(after);
  }).pipe(Effect.scoped, Effect.provide(services)),
);
