// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import type { ModuleManifest } from "@ibus-web/protocol";
import { preloadKey } from "@ibus-web/worker-host";
import { makeModuleRegistry, type ModuleEvent } from "../../../src/services/modules.ts";
import type { InstallOptions, InstallOutcome } from "../../../src/services/preload.ts";
import { EngineLoadFailed, PrepareEngineError } from "../../../src/errors.ts";
import { CoreConfig } from "../../../src/services/config.ts";
import { SettingsSource } from "../../../src/services/settings.ts";
import { Logger, PanelEvents } from "../../../src/services/logging.ts";
import { FakeConnection } from "../../shared/router.ts";

const services = Layer.mergeAll(CoreConfig.Default, SettingsSource.layer(), Logger.Default, PanelEvents.Default);
const basePath = `/nix/store/${"a".repeat(32)}-base`;
const lazyPath = `/nix/store/${"b".repeat(32)}-lazy`;
const manifestUrl = new URL("https://example.test/test/manifest.json");
const manifest: ModuleManifest = {
  name: "test",
  version: "1+nix.abc",
  license: "MIT",
  runtimeAbi: 1,
  runtimeIdentity: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  protocol: 1,
  module: { url: "./test.wasm", size: 100 },
  memory: 65536,
  threads: 0,
  data: [
    { storePath: basePath, url: "./data/base.tar.br", size: 1000, encoding: "br" },
    { storePath: lazyPath, url: "./data/lazy.tar.br", size: 5000, encoding: "br" },
  ],
  settingsSchemaDir: `${basePath}/schemas`,
  engines: [
    { name: "test", displayName: "test", languages: [], keyboard: { layout: "us", passThrough: [] } },
    { name: "lazy", displayName: "lazy", languages: [], keyboard: { layout: "us", passThrough: [] }, data: [lazyPath] },
  ],
  settingsSchemas: [],
};
const at = (path: string): string => new URL(path, manifestUrl).href;

// Cache Storage in memory: what was stored under each key.
class MemoryCache {
  readonly stored = new Map<string, Uint8Array<ArrayBuffer>>();
  async match(key: RequestInfo | URL): Promise<Response | undefined> {
    const bytes = this.stored.get(String(key));
    return bytes === undefined ? undefined : new Response(bytes);
  }
  async put(key: RequestInfo | URL, response: Response): Promise<void> {
    this.stored.set(String(key), new Uint8Array(await response.arrayBuffer()));
  }
}

// A network holding the module's files, in chunks of a tenth, and whatever
// it was asked for, with each request's priority.
const network = (missing: readonly string[] = []) => {
  const requests: { url: string; priority: string | undefined }[] = [];
  const files = new Map<string, number>([
    [manifestUrl.href, 64],
    [at("./test.wasm"), 100],
    [at("./data/base.tar.br"), 300],
    [at("./data/lazy.tar.br"), 2000],
  ]);
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({ url, priority: init?.priority });
    const length = files.get(url);
    if (length === undefined || missing.includes(url)) return new Response(null, { status: 404 });
    const chunk = Math.ceil(length / 10);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= length) return controller.close();
        const size = Math.min(chunk, length - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size));
      },
    });
    return new Response(body, { headers: { "Content-Length": String(length) } });
  };
  return { requests, fetch };
};

const registryWith = (
  cache: MemoryCache,
  fetch: typeof globalThis.fetch,
  more: {
    install?: (options: InstallOptions) => Promise<InstallOutcome>;
    start?: () => Promise<FakeConnection>;
  } = {},
) =>
  makeModuleRegistry({
    hostUrl: manifestUrl,
    runtimeUrl: manifestUrl,
    modules: { test: manifestUrl },
    loadManifest: async () => manifest,
    loadMetadata: async () => ({ schemas: [] }),
    waitForWriter: () => Effect.void,
    start:
      more.start ??
      (async () => {
        throw new Error("preloading started a Worker");
      }),
    preload: {
      caches: () => ({ open: async () => cache }) as unknown as CacheStorage,
      fetch,
      idle: async () => {},
      install:
        more.install ??
        (async () => {
          throw new Error("preloading installed");
        }),
    },
  });

const preloads = (events: readonly ModuleEvent[]) =>
  events.flatMap((event) =>
    event._tag === "preload" ? [{ engine: event.engine, bytes: event.bytes, total: event.total }] : [],
  );

it.effect("preload fetches a module's files and an engine's own data into the cache at low priority, once each", () =>
  Effect.gen(function* () {
    const cache = new MemoryCache();
    const { requests, fetch } = network();
    const registry = yield* registryWith(cache, fetch);
    const events = yield* registry.events.pipe(
      Stream.takeUntil((event) => event._tag === "preload" && event.engine === undefined),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Effect.yieldNow;

    yield* registry.preload([{ module: "test", engine: "lazy" }, { module: "test" }]);
    expect([...cache.stored.keys()].toSorted()).toEqual(
      [manifestUrl.href, at("./test.wasm"), at("./data/base.tar.br"), at("./data/lazy.tar.br")]
        .map((url) => preloadKey(url, manifest))
        .toSorted(),
    );
    expect(cache.stored.get(preloadKey(at("./data/lazy.tar.br"), manifest))?.byteLength).toBe(2000);
    expect(new Set(requests.map(({ priority }) => priority))).toEqual(new Set(["low"]));
    expect(registry.state("test"), "no Worker").toBe("starting");

    const reported = preloads([...(yield* Fiber.join(events))]);
    expect(reported[0], "the engine's entry, first").toEqual({ engine: "lazy", bytes: 0, total: 6100 });
    expect(reported.at(-2), "the engine's entry, last").toEqual({ engine: "lazy", bytes: 6100, total: 6100 });
    expect(reported.at(-1), "the module's entry, whose files came with the engine's").toEqual({
      engine: undefined,
      bytes: 0,
      total: 0,
    });
    expect(
      reported.slice(1, -2).every(({ bytes }) => bytes < 6100),
      "short of the total until stored",
    ).toBe(true);

    requests.length = 0;
    yield* registry.preload([{ module: "test", engine: "lazy" }]);
    expect(
      requests.map(({ url }) => url),
      "a second preload",
    ).toEqual([manifestUrl.href]);
  }).pipe(Effect.provide(services)),
);

it.effect("preload rejects an unknown module before fetching anything, and an unknown engine before its files", () =>
  Effect.gen(function* () {
    const cache = new MemoryCache();
    const { requests, fetch } = network();
    const registry = yield* registryWith(cache, fetch);

    expect((yield* Effect.flip(registry.preload([{ module: "missing" }]))).message).toBe("Unknown module: missing");
    expect((yield* Effect.flip(registry.preload([{ module: "test", engine: "missing" }]))).message).toBe(
      "Unknown engine: missing in module test",
    );
    expect(requests).toEqual([]);
    expect(cache.stored.size).toBe(0);
  }).pipe(Effect.provide(services)),
);

it.effect("a file that fails to fetch rejects with the error for what it is", () =>
  Effect.gen(function* () {
    const lazyFailed = yield* Effect.flip(
      Effect.flatMap(registryWith(new MemoryCache(), network([at("./data/lazy.tar.br")]).fetch), (registry) =>
        registry.preload([{ module: "test", engine: "lazy" }]),
      ),
    );
    expect(lazyFailed).toBeInstanceOf(PrepareEngineError);
    expect(lazyFailed).toMatchObject({ module: "test", engine: "lazy" });

    const moduleFailed = yield* Effect.flip(
      Effect.flatMap(registryWith(new MemoryCache(), network([at("./test.wasm")]).fetch), (registry) =>
        registry.preload([{ module: "test", engine: "lazy" }]),
      ),
    );
    expect(moduleFailed).toBeInstanceOf(EngineLoadFailed);
    expect(moduleFailed).toMatchObject({ module: "test" });
  }).pipe(Effect.provide(services)),
);

it.effect("install mode installs through a Worker of its own, reporting the base data, which a start waits for", () =>
  Effect.gen(function* () {
    const asked: InstallOptions[] = [];
    const called = yield* Deferred.make<void>();
    const installed = yield* Deferred.make<void>();
    let started = 0;
    const registry = yield* registryWith(new MemoryCache(), network().fetch, {
      install: async (options) => {
        asked.push(options);
        Deferred.doneUnsafe(called, Effect.void);
        options.progress(undefined, 1000, 1000);
        options.progress("lazy", 2500, 5000);
        await Effect.runPromise(Deferred.await(installed));
        options.progress("lazy", 5000, 5000);
        return "installed";
      },
      start: async () => {
        started++;
        const connection = new FakeConnection();
        connection.requestAsync = async () => ({ ret: 0, outSeq: 0, records: [] });
        return connection;
      },
    });
    const events = yield* registry.events.pipe(
      Stream.takeUntil((event) => event._tag === "preload" && event.bytes === 5000),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Effect.yieldNow;

    const preloading = yield* registry
      .preload([{ module: "test", engine: "lazy" }], { install: true })
      .pipe(Effect.forkChild);
    yield* Deferred.await(called);
    expect(asked.map(({ module, engines }) => ({ module, engines }))).toEqual([{ module: "test", engines: ["lazy"] }]);

    const selecting = yield* registry.select("test").pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(started, "a start while the install runs").toBe(0);
    yield* Deferred.succeed(installed, undefined);
    yield* Fiber.join(preloading);
    yield* Fiber.join(selecting);
    expect(started, "once it has ended").toBe(1);
    expect(preloads([...(yield* Fiber.join(events))])).toEqual([
      { engine: undefined, bytes: 1000, total: 1000 },
      { engine: "lazy", bytes: 2500, total: 5000 },
      { engine: "lazy", bytes: 5000, total: 5000 },
    ]);
  }).pipe(Effect.provide(services)),
);

it.effect("install mode skips a module another host writes, and fetches one whose storage would be memory", () =>
  Effect.gen(function* () {
    const skipped = new MemoryCache();
    yield* Effect.flatMap(registryWith(skipped, network().fetch, { install: async () => "writer" }), (registry) =>
      registry.preload([{ module: "test", engine: "lazy" }], { install: true }),
    );
    expect(skipped.stored.size).toBe(0);

    const fetched = new MemoryCache();
    yield* Effect.flatMap(registryWith(fetched, network().fetch, { install: async () => "ephemeral" }), (registry) =>
      registry.preload([{ module: "test", engine: "lazy" }], { install: true }),
    );
    expect(fetched.stored.has(preloadKey(at("./data/lazy.tar.br"), manifest))).toBe(true);
  }).pipe(Effect.provide(services)),
);

it.effect("install mode prepares through the Worker this page runs for the module", () =>
  Effect.gen(function* () {
    const connection = new FakeConnection();
    connection.requestAsync = async () => ({ ret: 0, outSeq: 0, records: [] });
    const registry = yield* registryWith(new MemoryCache(), network().fetch, { start: async () => connection });
    yield* registry.select("test");

    yield* registry.preload([{ module: "test", engine: "lazy" }, { module: "test" }], { install: true });
    expect(connection.prepared).toEqual(["lazy"]);
  }).pipe(Effect.provide(services)),
);

// Install-only Workers that each run until the test ends them, counting how
// many run at once.
const installs = () => {
  const asked: InstallOptions[] = [];
  const ends: (() => void)[] = [];
  let running = 0;
  let most = 0;
  const install = async (options: InstallOptions): Promise<InstallOutcome> => {
    asked.push(options);
    running++;
    most = Math.max(most, running);
    await new Promise<void>((resolve) => ends.push(resolve));
    running--;
    return "installed";
  };
  return { asked, ends, install, most: () => most };
};

// Lets what the fibers started run for a while, on the real clock.
const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));

const fakeStart = (count: () => void) => async () => {
  count();
  const connection = new FakeConnection();
  connection.requestAsync = async () => ({ ret: 0, outSeq: 0, records: [] });
  return connection;
};

it.effect("install mode runs one install-only Worker of a module at a time, and a start waits for the last", () =>
  Effect.gen(function* () {
    const fake = installs();
    let started = 0;
    const registry = yield* registryWith(new MemoryCache(), network().fetch, {
      install: fake.install,
      start: fakeStart(() => started++),
    });

    const first = yield* registry
      .preload([{ module: "test", engine: "lazy" }], { install: true })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => vi.waitFor(() => expect(fake.asked).toHaveLength(1)));
    const second = yield* registry.preload([{ module: "test" }], { install: true }).pipe(Effect.forkChild);
    yield* settle;
    expect(fake.asked, "the second while the first runs").toHaveLength(1);

    fake.ends[0]!();
    yield* Fiber.join(first);
    yield* Effect.promise(() => vi.waitFor(() => expect(fake.asked).toHaveLength(2)));
    const selecting = yield* registry.select("test").pipe(Effect.forkChild);
    yield* settle;
    expect(started, "a start while the second runs").toBe(0);

    fake.ends[1]!();
    yield* Fiber.join(second);
    yield* Fiber.join(selecting);
    expect(started).toBe(1);
    expect(fake.most(), "install-only Workers at once").toBe(1);
  }).pipe(Effect.provide(services)),
);

it.effect("an install preload waiting on another leaves its module to the Worker a start made meanwhile", () =>
  Effect.gen(function* () {
    const fake = installs();
    let started = 0;
    const registry = yield* registryWith(new MemoryCache(), network().fetch, {
      install: fake.install,
      start: fakeStart(() => started++),
    });

    const first = yield* registry.preload([{ module: "test" }], { install: true }).pipe(Effect.forkChild);
    yield* Effect.promise(() => vi.waitFor(() => expect(fake.asked).toHaveLength(1)));
    const second = yield* registry.preload([{ module: "test" }], { install: true }).pipe(Effect.forkChild);
    yield* settle;
    const selecting = yield* registry.select("test").pipe(Effect.forkChild);
    yield* settle;
    expect(started, "a start while the first runs").toBe(0);

    fake.ends[0]!();
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    yield* Fiber.join(selecting);
    expect(started).toBe(1);
    expect(fake.asked, "install-only Workers").toHaveLength(1);
  }).pipe(Effect.provide(services)),
);
