// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Effect, Layer } from "effect";
import type { ModuleManifest } from "@ibus-web/protocol";
import { CoreConfig } from "../../../src/services/config.ts";
import { SettingsSource } from "../../../src/services/settings.ts";
import { Logger, PanelEvents } from "../../../src/services/logging.ts";
import { ModuleRegistry } from "../../../src/services/modules.ts";
import { Router } from "../../../src/router/router.ts";
import { StorageApi } from "../../../src/storage/api.ts";
import { FakeConnection } from "../../shared/router.ts";

const manifestUrl = new URL("https://example.test/test/manifest.json");
const manifest: ModuleManifest = {
  kind: "js",
  name: "test",
  version: "1",
  license: "MIT",
  protocol: 1,
  moduleAbi: 1,
  module: { url: "./test.js", size: 100 },
  engines: [
    { name: "one", displayName: "one", languages: [], keyboard: { layout: "us", passThrough: [] } },
    { name: "two", displayName: "two", languages: [], keyboard: { layout: "us", passThrough: [] } },
  ],
  settingsSchemas: [],
};

// A module that starts on a connection of its own each time, and a storage Worker that fails the test if asked for.
const setup = () => {
  const starts: FakeConnection[] = [];
  const kinds: (string | undefined)[] = [];
  const workers: URL[] = [];
  const registry = ModuleRegistry.layer({
    hostUrl: manifestUrl,
    runtimeUrl: manifestUrl,
    modules: { test: manifestUrl },
    loadManifest: async () => manifest,
    loadMetadata: async () => ({ schemas: [] }),
    waitForWriter: () => Effect.void,
    start: async ({ kind }) => {
      kinds.push(kind);
      const connection = new FakeConnection();
      connection.requestAsync = async () => ({ ret: 0, outSeq: 0, records: [] });
      // A connection that can check storage, which only a WebAssembly module's start gives a watch.
      Object.assign(connection, { checkStorage: () => {} });
      starts.push(connection);
      return connection;
    },
  });
  const base = Layer.mergeAll(CoreConfig.Default, SettingsSource.layer(), Logger.Default, PanelEvents.Default);
  const router = Router.Default.pipe(Layer.provide(registry), Layer.provide(base));
  const storage = StorageApi.layer({
    hostUrl: manifestUrl,
    modules: { test: manifestUrl },
    storageWorker: (url) => {
      workers.push(url);
      throw new Error("a JavaScript module opened a storage Worker");
    },
  }).pipe(Layer.provide(Layer.mergeAll(registry, router)), Layer.provide(base));
  return { starts, kinds, workers, layer: Layer.mergeAll(registry, router, storage).pipe(Layer.provideMerge(base)) };
};

it.effect("usage reports zeros for a JavaScript module and export an empty tar, with no storage Worker", () => {
  const { workers, layer } = setup();
  return Effect.gen(function* () {
    const api = yield* StorageApi;

    expect(yield* api.usage()).toEqual({
      modules: {
        test: {
          data: 0,
          userData: 0,
          engines: { one: { data: 0 }, two: { data: 0 } },
          version: "1",
          versions: {},
          total: 0,
        },
      },
    });

    const archive = yield* api.export("test");
    expect(archive.type).toBe("application/x-tar");
    expect(new Uint8Array(yield* Effect.promise(() => archive.arrayBuffer()))).toEqual(new Uint8Array(1024));
    expect(workers).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("reset restarts a running JavaScript module and deletes nothing", () => {
  const { starts, kinds, workers, layer } = setup();
  return Effect.gen(function* () {
    const router = yield* Router;
    const registry = yield* ModuleRegistry;
    const api = yield* StorageApi;

    yield* router.select("test", "two");
    expect(starts).toHaveLength(1);

    yield* api.reset("test");
    expect(starts, "started again").toHaveLength(2);
    expect(starts[0]!.terminated).toBe(true);
    expect(router.selection).toEqual({ module: "test", engine: "two" });
    expect(registry.started("test")).toBe(true);
    expect(kinds, "each connection told it starts a JavaScript module").toEqual(["js", "js"]);
    expect(workers).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("reset of a JavaScript module that isn't running starts nothing", () => {
  const { starts, workers, layer } = setup();
  return Effect.gen(function* () {
    yield* (yield* StorageApi).reset("test");
    expect(starts).toEqual([]);
    expect(workers).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("a JavaScript module's start watches no database", () => {
  const { layer } = setup();
  const open = vi.fn(() => ({}));
  vi.stubGlobal("indexedDB", { open });
  return Effect.gen(function* () {
    yield* (yield* Router).select("test", "one");
    expect(open).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())));
});
