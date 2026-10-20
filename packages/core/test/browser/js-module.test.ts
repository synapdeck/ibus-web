// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { CreateEngine, ProcessKeyEvent } from "@ibus-web/protocol";
import { Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect, test } from "vitest";
import { preloadCacheName } from "@ibus-web/worker-host";
import {
  Connection,
  CoreConfig,
  EngineHung,
  Logger,
  ModuleRegistry,
  PanelEvents,
  Router,
  SettingsSource,
  StorageApi,
} from "../../src/page/index.ts";
import { data } from "./real-host.ts";

const manifestUrl = new URL(data.jsUrl, location.href);
const scriptUrl = new URL("module.mjs", manifestUrl);
const scriptSize = (await (await fetch(manifestUrl)).json()).module.size as number;

const run = <A>(body: (registry: ModuleRegistry["Service"], storage: StorageApi["Service"]) => Promise<A>) => {
  const starts: Connection[] = [];
  const registry = ModuleRegistry.layer({
    hostUrl: new URL(data.hostUrl, location.href),
    runtimeUrl: new URL(data.runtimes[0]!.url, location.href),
    modules: { "page-js": manifestUrl },
    storage: "browser",
    start: async (options) => {
      const connection = await Connection.start(options);
      starts.push(connection);
      return connection;
    },
  });
  const base = Layer.mergeAll(CoreConfig.Default, Logger.Default, PanelEvents.Default, SettingsSource.layer());
  const router = Router.Default.pipe(Layer.provide(registry), Layer.provide(base));
  const storage = StorageApi.layer({
    hostUrl: new URL(data.hostUrl, location.href),
    modules: { "page-js": manifestUrl },
  }).pipe(Layer.provide(Layer.mergeAll(registry, router)), Layer.provide(base));
  return Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ModuleRegistry;
      const storage = yield* StorageApi;

      return yield* Effect.promise(() => body(registry, storage));
    }).pipe(Effect.provide(Layer.mergeAll(registry, router, storage).pipe(Layer.provideMerge(base))), Effect.scoped),
  ).then((result) => ({ result, starts }));
};

const databases = async () =>
  (await indexedDB.databases()).flatMap(({ name }) => (name?.startsWith("ibus-web/") ? [name] : []));

describe("a JavaScript module on the page", () => {
  test("preload fetches its script, keeps it out of Cache Storage, and install mode has nothing to install", async () => {
    await caches.delete(preloadCacheName);
    await run(async (registry) => {
      const sizes: number[] = [];
      const watching = Effect.runFork(
        registry.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event._tag === "preload") sizes.push(event.bytes);
            }),
          ),
        ),
      );
      await Effect.runPromise(registry.preload([{ module: "page-js", engine: "one" }]));
      await Effect.runPromise(Fiber.interrupt(watching));
      expect(sizes.at(-1), "the script's size, reported").toBe(scriptSize);

      await Effect.runPromise(registry.preload([{ module: "page-js" }], { install: true }));
    });
    const keys = (await (await caches.open(preloadCacheName)).keys()).map(({ url }) => url);
    expect(keys, "the manifest alone").toHaveLength(1);
    expect(keys[0]).toContain(manifestUrl.pathname);
    expect(keys).not.toContain(scriptUrl.href);
    expect(await databases(), "no database opened").toEqual([]);
  });

  test("usage reports zeros, export an empty tar, and reset restarts the module with no database touched", async () => {
    const { starts } = await run(async (registry, storage) => {
      await Effect.runPromise(registry.start("page-js"));
      expect(await Effect.runPromise(storage.usage())).toMatchObject({
        modules: { "page-js": { data: 0, userData: 0, total: 0, engines: { one: { data: 0 } } } },
      });
      const archive = await Effect.runPromise(storage.export("page-js"));
      expect((await archive.arrayBuffer()).byteLength).toBe(1024);

      await Effect.runPromise(storage.reset("page-js"));
      expect(registry.started("page-js")).toBe(true);
    });
    expect(starts).toHaveLength(2);
    expect(await databases()).toEqual([]);
  });

  test("a handler that never returns hangs the module, which the page ends and restarts with EngineHung", async () => {
    await run(async (registry) => {
      let restarting!: (error: unknown) => void;
      const restarted = new Promise<unknown>((resolve) => {
        restarting = resolve;
      });
      const watching = Effect.runFork(
        registry.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event._tag === "state" && event.state === "restarting") restarting(event.error);
            }),
          ),
        ),
      );

      await Effect.runPromise(registry.start("page-js"));
      expect((await registry.request("page-js", new CreateEngine({ name: "stall" }), 1)).ret).toBe(0);
      const key = registry.request("page-js", new ProcessKeyEvent({ keyval: 0x61, keycode: 30, state: 0 }), 1).then(
        () => "answered",
        () => "abandoned",
      );

      expect(await restarted).toBeInstanceOf(EngineHung);
      expect(await key).toBe("abandoned");
      await Effect.runPromise(Fiber.interrupt(watching));
    });
  });
});
