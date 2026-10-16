// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { stringVariant, type ModuleManifest } from "@ibus-web/protocol";
import { ConnectionFailed } from "../../../src/connection/crash.ts";
import {
  crashError,
  EngineCrashed,
  EngineHung,
  EngineLoadFailed,
  isIbusWebError,
  ProtocolError,
  ProtocolMismatch,
  RuntimeAbiMismatch,
  StorageUnavailable,
} from "../../../src/errors.ts";
import { makeModuleRegistry, type ModuleEvent, type ModuleRegistryOptions } from "../../../src/services/modules.ts";
import { CoreConfig } from "../../../src/services/config.ts";
import { SettingsSource } from "../../../src/services/settings.ts";
import { Logger, PanelEvents } from "../../../src/services/logging.ts";
import { SettingsApi } from "../../../src/settings/api.ts";
import { FakeConnection } from "../../shared/router.ts";

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
const metadata = {
  schemas: [
    { id: "settings", paths: ["/settings/"], keys: [{ name: "mode", type: "s", default: { _tag: "s", value: "a" } }] },
  ],
};
const url = new URL("https://example.test/");
const services = Layer.mergeAll(CoreConfig.Default, SettingsSource.layer(), Logger.Default, PanelEvents.Default);
const emptyReply = { ret: 0, outSeq: 0, records: [] };

const registryWith = (options: Partial<ModuleRegistryOptions>) =>
  makeModuleRegistry({
    hostUrl: url,
    runtimeUrl: url,
    modules: { test: url },
    loadManifest: async () => manifest,
    loadMetadata: async () => metadata,
    waitForWriter: () => Effect.void,
    start: async () => {
      const connection = new FakeConnection();
      connection.requestAsync = async () => emptyReply;
      return connection;
    },
    ...options,
  });

// The registry's state events from now until the scope closes.
const stateEvents = (events: Stream.Stream<ModuleEvent>) =>
  Effect.gen(function* () {
    const seen: Extract<ModuleEvent, { _tag: "state" }>[] = [];
    yield* events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event._tag === "state") seen.push(event);
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    return seen;
  });

const settle = Effect.gen(function* () {
  for (let i = 0; i < 5; i++) yield* Effect.yieldNow;
});

it.effect("a module that can't start rejects select with its tagged error and fails with it on modulestate", () =>
  Effect.gen(function* () {
    const memory = yield* SettingsSource;
    const cases: { options: Partial<ModuleRegistryOptions>; error: object; storage?: boolean }[] = [
      {
        options: {
          loadManifest: async () => {
            throw new Error("Manifest fetch failed: 404");
          },
        },
        error: { _tag: "EngineLoadFailed", diagnostic: "Manifest fetch failed: 404" },
      },
      {
        options: { loadManifest: async () => ({ ...manifest, protocol: 2 }) },
        error: { _tag: "ProtocolMismatch", diagnostic: "page 1, manifest 2" },
      },
      {
        options: {
          start: async () => {
            throw new ConnectionFailed({
              reason: "load",
              message: "RuntimeAbiMismatch: manifest identity 0, runtime 1",
              refused: "RuntimeAbiMismatch",
            });
          },
        },
        error: { _tag: "RuntimeAbiMismatch", diagnostic: "RuntimeAbiMismatch: manifest identity 0, runtime 1" },
      },
      {
        options: {
          start: async () => {
            const connection = new FakeConnection();
            connection.requestAsync = async () => {
              throw new RangeError("request of 70000 bytes");
            };
            return connection;
          },
        },
        error: { _tag: "ProtocolError", diagnostic: "request of 70000 bytes" },
      },
      { options: {}, error: { _tag: "StorageUnavailable", diagnostic: "the database is blocked" }, storage: true },
    ];
    for (const { options, error, storage } of cases) {
      const registry = yield* registryWith(options).pipe(
        Effect.provideService(SettingsSource, {
          ...memory,
          snapshot: storage ? () => Promise.reject(new Error("the database is blocked")) : memory.snapshot,
        }),
      );
      const states = yield* stateEvents(registry.events);
      const failed = yield* Effect.flip(registry.select("test"));
      expect(failed).toMatchObject({ ...error, module: "test" });
      expect(failed).toBeInstanceOf(Error);
      expect(isIbusWebError(failed)).toBe(true);
      yield* settle;
      expect(states.at(-1)).toEqual({ _tag: "state", module: "test", state: "failed", error: failed });
    }
  }).pipe(Effect.provide(services)),
);

it.effect("engines() rejects an unreadable or mismatched manifest with its tagged error", () =>
  Effect.gen(function* () {
    const unreadable = yield* registryWith({ loadManifest: async () => ({ ...manifest, engines: [] }) });
    expect(yield* Effect.flip(unreadable.engines("test"))).toBeInstanceOf(EngineLoadFailed);
    const mismatched = yield* registryWith({ loadManifest: async () => ({ ...manifest, protocol: 2 }) });
    expect(yield* Effect.flip(mismatched.engines("test"))).toBeInstanceOf(ProtocolMismatch);
    const refused = yield* registryWith({
      start: async () => {
        throw new ConnectionFailed({ reason: "load", message: "manifest (memory bounds)", refused: "manifest" });
      },
    });
    expect(yield* Effect.flip(refused.select("test"))).toBeInstanceOf(EngineLoadFailed);
  }).pipe(Effect.provide(services)),
);

it.effect("a ready module's crash and hang reach modulestate as EngineCrashed and EngineHung, cleared once ready", () =>
  Effect.gen(function* () {
    const connections: FakeConnection[] = [];
    const registry = yield* registryWith({
      start: async () => {
        const connection = new FakeConnection();
        connection.requestAsync = async () => emptyReply;
        connections.push(connection);
        return connection;
      },
    });
    const states = yield* stateEvents(registry.events);
    // The state events since `from`, by state.
    const since = (from: number, state: string) => states.slice(from).find((event) => event.state === state);
    yield* registry.select("test");

    let from = states.length;
    connections[0]!.crash({ reason: "fault", message: "an engine threw: boom" });
    yield* registry.whenReady("test");
    yield* settle;
    const faulted = since(from, "restarting")!.error;
    expect(faulted).toBeInstanceOf(EngineCrashed);
    expect(faulted).toMatchObject({ module: "test", reason: "FAULT", diagnostic: "an engine threw: boom" });
    expect(since(from, "ready")).toEqual({ _tag: "state", module: "test", state: "ready" });

    from = states.length;
    connections[1]!.crash({ reason: "hang", message: "Worker request stopped making progress" });
    yield* settle;
    expect(since(from, "restarting")!.error).toBeInstanceOf(EngineHung);
    yield* TestClock.adjust(250);
    yield* registry.whenReady("test");

    // The third crash in a minute fails the module, for that crash.
    from = states.length;
    connections.at(-1)!.crash({ reason: "trap", message: "unreachable" });
    yield* settle;
    const failed = since(from, "failed")!.error;
    expect(failed).toMatchObject({ _tag: "EngineCrashed", reason: "TRAP", diagnostic: "unreachable" });
    expect(yield* Effect.flip(registry.whenReady("test"))).toBe(failed);
  }).pipe(Effect.provide(services)),
);

it.effect("a restart that fails after its Worker started keeps that start's tagged error, not a load crash", () =>
  Effect.gen(function* () {
    const connections: FakeConnection[] = [];
    const registry = yield* registryWith({
      start: async () => {
        const connection = new FakeConnection();
        connection.requestAsync =
          connections.length === 0
            ? async () => emptyReply
            : async () => {
                throw new Error("Init lost its reply");
              };
        connections.push(connection);
        return connection;
      },
    });
    const states = yield* stateEvents(registry.events);
    yield* registry.select("test");

    // Every restart fails its Init, until the third crash in a minute fails the module.
    connections[0]!.crash({ reason: "fault", message: "an engine threw: boom" });
    for (let i = 0; i < 20 && !states.some((event) => event.state === "failed"); i++) {
      yield* settle;
      yield* TestClock.adjust(250);
    }
    expect(connections.length).toBeGreaterThan(1);
    const failed = states.find((event) => event.state === "failed")?.error;
    expect(failed).toBeInstanceOf(EngineLoadFailed);
    expect(failed).toMatchObject({ module: "test", diagnostic: "Init lost its reply" });
  }).pipe(Effect.provide(services)),
);

it.effect(
  "the settings calls reject an unusable store with StorageUnavailable and an unreadable module with EngineLoadFailed",
  () =>
    Effect.gen(function* () {
      const memory = yield* SettingsSource;
      const settings = SettingsApi.layer({
        modules: { test: url, missing: new URL("https://example.test/missing/") },
        loadManifest: async (manifestUrl) => {
          if (manifestUrl.pathname === "/missing/") throw new Error("Settings fetch failed: 404");
          return manifest;
        },
        loadMetadata: async () => metadata,
      }).pipe(
        Layer.provide(
          Layer.succeed(SettingsSource, {
            ...memory,
            read: () => Promise.reject(new Error("the database is closed")),
            write: () => Promise.reject(new Error("the database is closed")),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const api = yield* SettingsApi;
        const read = yield* Effect.flip(Effect.tryPromise(() => api.get("test", "/settings/", "mode")));
        expect(read.cause).toBeInstanceOf(StorageUnavailable);
        expect(read.cause).toMatchObject({ module: "test", diagnostic: "the database is closed" });
        const written = yield* Effect.flip(
          Effect.tryPromise(() => api.set("test", "/settings/", "mode", stringVariant("b"))),
        );
        expect(written.cause).toBeInstanceOf(StorageUnavailable);
        const unread = yield* Effect.flip(Effect.tryPromise(() => api.schemas("missing")));
        expect(unread.cause).toBeInstanceOf(EngineLoadFailed);
        expect(unread.cause).toMatchObject({ module: "missing", diagnostic: "Settings fetch failed: 404" });
      }).pipe(Effect.provide(settings));
    }).pipe(Effect.provide(services)),
);

it("each error is an Error whose message names the module, the engine and the diagnostic", () => {
  expect(new EngineCrashed({ module: "rime", reason: "TRAP", diagnostic: "unreachable" }).message).toBe(
    "Module rime crashed (TRAP): unreachable",
  );
  expect(new ProtocolError({ module: "m17n", engine: "m17n:hi:inscript" }).message).toBe(
    "Engine m17n:hi:inscript of module m17n broke the protocol",
  );
  const error = new RuntimeAbiMismatch({ module: "hangul" });
  expect(error).toBeInstanceOf(Error);
  expect(error._tag).toBe("RuntimeAbiMismatch");
  expect(isIbusWebError(new Error("plain"))).toBe(false);
  for (const [reason, name] of [
    ["trap", "TRAP"],
    ["fault", "FAULT"],
    ["relay", "RELAY"],
    ["load", "LOAD"],
    ["host", "HOST"],
    ["worker", "HOST"],
  ] as const)
    expect(crashError("m", { reason, message: "x" })).toMatchObject({
      _tag: "EngineCrashed",
      module: "m",
      reason: name,
      diagnostic: "x",
    });
  expect(crashError("m", { reason: "hang", message: "x" })).toBeInstanceOf(EngineHung);
});
