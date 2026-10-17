// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Effect, Layer, Logger as EffectLogger, Stream } from "effect";
import {
  CreateEngine,
  IBusCapability,
  SetCapabilities,
  Enable,
  FocusIn,
  ProcessKeyEvent,
  encodeSettingsMetadata,
  encodeValue,
  int32Variant,
  stringVariant,
  type Request,
  type ModuleManifest,
  type SettingsMetadata,
} from "@ibus-web/protocol";
import { Connection, SettingsApi, indexedDbSettings } from "../../src/page/index.ts";
import { SettingsSource, type SettingsChange } from "../../src/services/settings.ts";
import { makeModuleRegistry } from "../../src/services/modules.ts";
import { CoreConfig } from "../../src/services/config.ts";
import { Logger, PanelEvents } from "../../src/services/logging.ts";
import { DomConnection, record } from "./support/dom.ts";
import { fixture, key } from "../shared/router.ts";

const PATH = "/test/settings/";
const instance = { schemaId: "test.settings", path: PATH };
const metadata: SettingsMetadata = {
  schemas: [
    {
      id: "test.settings",
      paths: [PATH],
      keys: [
        { name: "mode", type: "s", default: { _tag: "s", value: "default" }, choices: ["default", "chosen", "remote"] },
        {
          name: "count",
          type: "i",
          default: { _tag: "i", value: 1 },
          range: { min: { _tag: "i", value: 0 }, max: { _tag: "i", value: 3 } },
        },
      ],
    },
    {
      id: "test.relocatable",
      paths: ["/test/relocatable/first/", "/test/relocatable/second/"],
      keys: [{ name: "mode", type: "s", default: { _tag: "s", value: "default" } }],
    },
  ],
};
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
  data: [{ storePath: `/nix/store/${"a".repeat(32)}-test`, url: "data.tar", size: 0, files: 1, encoding: "identity" }],
  settingsSchemaDir: `/nix/store/${"a".repeat(32)}-test/schemas`,
  engines: [{ name: "test", displayName: "test", languages: [], keyboard: { layout: "us", passThrough: [] } }],
  settingsSchemas: ["test.settings", "test.relocatable"],
  settingsMetadata: { url: "settings.json", size: 1 },
};
const options: {
  modules: Record<string, URL>;
  loadManifest: (url: URL) => Promise<unknown>;
  loadMetadata: (url: URL) => Promise<unknown>;
} = {
  modules: { a: new URL("/a/manifest.json", location.href), b: new URL("/b/manifest.json", location.href) },
  loadManifest: async (url: URL) => ({ ...manifest, name: url.pathname.split("/")[1] }),
  loadMetadata: async () => encodeSettingsMetadata(metadata),
};
const base = Layer.mergeAll(CoreConfig.Default, Logger.Default, PanelEvents.Default);
const drop = () =>
  new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("gsettings");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Database still open"));
  });
beforeEach(drop);
afterEach(() => vi.restoreAllMocks());
async function stored() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("gsettings", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction("values");
      const request = tx.objectStore("values").getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
const run = (
  body: (
    api: SettingsApi["Service"],
    source: SettingsSource["Service"],
    registry: Effect.Success<ReturnType<typeof makeModuleRegistry>>,
    connections: DomConnection[],
  ) => Promise<void>,
  source = indexedDbSettings(),
  moduleOptions = options,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* SettingsApi;
        const settings = yield* SettingsSource;
        const connections: DomConnection[] = [];
        const registry = yield* makeModuleRegistry({
          ...moduleOptions,
          hostUrl: new URL("/host", location.href),
          runtimeUrl: new URL("/runtime", location.href),
          start: async () => {
            const c = new DomConnection();
            connections.push(c);
            return c;
          },
        });
        yield* Effect.promise(() => body(api, settings, registry, connections));
      }).pipe(Effect.provide(SettingsApi.layer(moduleOptions)), Effect.provide(Layer.mergeAll(base, source))),
    ),
  );

test("API loads validated metadata and persists ArrayBuffers without starting Workers; Init declares every instance", () =>
  run(async (api, source, registry, connections) => {
    expect(await api.schemas("a")).toEqual(metadata.schemas);
    expect(await api.get("a", PATH, "mode")).toEqual(stringVariant("default"));
    await api.set("a", PATH, "mode", stringVariant("chosen"));
    expect(connections).toHaveLength(0);
    expect(await stored()).toEqual([{ type: "s", bytes: encodeValue("s", { _tag: "s", value: "chosen" }).buffer }]);
    expect((await stored())[0]).toHaveProperty("bytes", expect.any(ArrayBuffer));
    await Effect.runPromise(registry.ensure("a"));
    expect(connections[0]!.sent[0]!.request).toMatchObject({
      _tag: "Init",
      settings: [
        { schemaId: "test.settings", path: PATH, values: { mode: stringVariant("chosen") } },
        { schemaId: "test.relocatable", path: "/test/relocatable/first/", values: {} },
        { schemaId: "test.relocatable", path: "/test/relocatable/second/", values: {} },
      ],
    });
    expect(await source.snapshot([instance])).toEqual({ [PATH]: { mode: stringVariant("chosen") } });
    await api.set("a", PATH, "mode", stringVariant("default"));
    expect(await stored()).toEqual([]);
    await api.set("a", PATH, "mode", stringVariant("chosen"));
    await api.reset("a", PATH, "mode");
    expect(await stored()).toEqual([]);
  }));
test("relocatable instances keep their own values and changes", () =>
  run(async (api, source, registry, connections) => {
    await Effect.runPromise(registry.ensure("a"));
    connections[0]!.sent.length = 0;
    await api.set("a", "/test/relocatable/second/", "mode", stringVariant("chosen"));
    await connections[0]!.untilSent("SettingChanged");
    expect(connections[0]!.sent.at(-1)!.request).toMatchObject({
      _tag: "SettingChanged",
      path: "/test/relocatable/second/",
      key: "mode",
      value: stringVariant("chosen"),
    });
    expect(await api.get("a", "/test/relocatable/first/", "mode")).toEqual(stringVariant("default"));
    expect(
      await source.snapshot([
        { schemaId: "test.relocatable", path: "/test/relocatable/first/" },
        { schemaId: "test.relocatable", path: "/test/relocatable/second/" },
      ]),
    ).toEqual({ "/test/relocatable/first/": {}, "/test/relocatable/second/": { mode: stringVariant("chosen") } });
  }));
test("engine writes synchronously enqueue, reach the API stream and other Worker, and never echo to writer", () =>
  run(async (api, _source, registry, connections) => {
    await Effect.runPromise(registry.ensure("a"));
    await Effect.runPromise(registry.ensure("b"));
    const f = fixture();
    registry.registerContext("a", f.context);
    const changes: unknown[] = [];
    const controller = new AbortController();
    const watching = Effect.runPromise(
      api.changes.pipe(
        Stream.take(2),
        Stream.runForEach((value) =>
          Effect.sync(() => {
            changes.push(value);
          }),
        ),
      ),
      { signal: controller.signal },
    );
    try {
      await api.set("a", PATH, "mode", stringVariant("remote"));
      connections[0]!.sent.length = 0;
      connections[1]!.sent.length = 0;
      connections[0]!.outcome = {
        _tag: "reply",
        ret: 1,
        records: [record({ _tag: "SettingWritten", path: PATH, key: "mode", value: stringVariant("chosen") })],
      };
      expect(registry.keySink("a", f.context).key(key("a"))).toBe("consumed");
      await connections[1]!.untilSent("SettingChanged");
      await watching;
      expect(changes).toHaveLength(2);
      expect(changes[1]).toMatchObject({ schemaId: "test.settings", path: PATH, value: stringVariant("chosen") });
      expect(connections[0]!.sent.filter(({ request }) => request._tag === "SettingChanged")).toEqual([]);
      expect(connections[1]!.sent.at(-1)!.request).toMatchObject({
        _tag: "SettingChanged",
        path: PATH,
        value: stringVariant("chosen"),
      });
      expect(await stored()).toEqual([{ type: "s", bytes: encodeValue("s", { _tag: "s", value: "chosen" }).buffer }]);
    } finally {
      controller.abort();
      await watching.catch(() => {});
    }
  }));
test("another page receives exact broadcast bytes and forwards remote changes without writing or rebroadcasting", () =>
  run(async (api, _source, registry, connections) => {
    await Effect.runPromise(registry.ensure("a"));
    const other = new BroadcastChannel("ibus-web:gsettings");
    try {
      const received = new Promise<unknown>((resolve) => {
        other.onmessage = (event) => resolve(event.data);
      });
      await api.set("a", PATH, "mode", stringVariant("chosen"));
      expect(await received).toEqual({
        schemaPath: PATH,
        key: "mode",
        type: "s",
        bytes: encodeValue("s", { _tag: "s", value: "chosen" }).buffer,
      });
      connections[0]!.sent.length = 0;
      const put = vi.spyOn(IDBObjectStore.prototype, "put");
      const remove = vi.spyOn(IDBObjectStore.prototype, "delete");
      other.postMessage({
        schemaPath: PATH,
        key: "mode",
        type: "s",
        bytes: encodeValue("s", { _tag: "s", value: "remote" }).buffer,
      });
      await connections[0]!.untilSent("SettingChanged");
      expect(connections[0]!.sent.at(-1)!.request).toMatchObject({ path: PATH, value: stringVariant("remote") });
      expect(put).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      connections[0]!.sent.length = 0;
      other.postMessage({ schemaPath: PATH, key: "mode", type: "s", bytes: null });
      await connections[0]!.untilSent("SettingChanged");
      expect(connections[0]!.sent.at(-1)!.request).toMatchObject({ value: stringVariant("default") });
      expect(put).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    } finally {
      other.close();
    }
  }));
test("rejects unknown paths, keys, signatures, choices and ranges before storage", () =>
  run(async (api) => {
    await expect(api.set("a", "/test/missing/", "mode", stringVariant("chosen"))).rejects.toThrow();
    await expect(api.set("a", PATH, "missing", stringVariant("chosen"))).rejects.toThrow();
    await expect(api.set("a", PATH, "count", stringVariant("chosen"))).rejects.toThrow();
    await expect(api.set("a", PATH, "mode", stringVariant("invalid"))).rejects.toThrow();
    await expect(api.set("a", PATH, "count", int32Variant(4))).rejects.toThrow();
  }));
test("a host-supplied source replaces persistence entirely, including settings API access", async () => {
  const open = vi.spyOn(IDBFactory.prototype, "open");
  await run(async (api, _source, registry) => {
    await api.set("a", PATH, "mode", stringVariant("chosen"));
    await Effect.runPromise(registry.ensure("a"));
    expect(await api.get("a", PATH, "mode")).toEqual(stringVariant("chosen"));
    expect(open).not.toHaveBeenCalled();
  }, SettingsSource.layer());
});
test("a fresh page reads persisted bytes before starting a real Hangul Worker", async () => {
  const { data, HANGUL_SCHEMA, HANGUL_PATH } = await import("./real-host.ts");
  const realOptions = { modules: { hangul: new URL(data.hangulUrl, location.href) } };
  await Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* SettingsApi;
      yield* Effect.promise(() => api.set("hangul", HANGUL_PATH, "initial-input-mode", stringVariant("hangul")));
    }).pipe(Effect.provide(SettingsApi.layer(realOptions)), Effect.provide(indexedDbSettings())),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const requests: Request[] = [];
        const registry = yield* makeModuleRegistry({
          ...realOptions,
          hostUrl: new URL(data.hostUrl, location.href),
          runtimeUrl: new URL(data.runtimes[0]!.url, location.href),
          storage: "none",
          start: async (options) => {
            const connection = await Connection.start(options);
            const request = connection.requestAsync.bind(connection);
            connection.requestAsync = (value, ic) => {
              requests.push(value);
              return request(value, ic);
            };
            return connection;
          },
        });
        yield* registry.ensure("hangul");
        expect(requests[0]).toMatchObject({
          _tag: "Init",
          settings: expect.arrayContaining([
            {
              schemaId: HANGUL_SCHEMA,
              path: HANGUL_PATH,
              values: { "initial-input-mode": stringVariant("hangul") },
            },
            { schemaId: "org.freedesktop.ibus.panel", path: "/desktop/ibus/panel/", values: {} },
          ]),
        });
        yield* Effect.promise(async () => {
          for (const request of [
            new CreateEngine({ name: "hangul" }),
            new SetCapabilities({ capabilities: IBusCapability.PREEDIT_TEXT | IBusCapability.FOCUS }),
            new Enable({}),
            new FocusIn({}),
          ])
            expect((await registry.request("hangul", request, 1)).ret).toBeGreaterThanOrEqual(0);
          const reply = await registry.request(
            "hangul",
            new ProcessKeyEvent({ keyval: 103, keycode: 34, state: 0 }),
            1,
          );
          expect(reply.ret).toBe(1);
          expect(
            reply.records.some(({ record }) => record._tag === "UpdatePreeditText" && record.text.text === "ㅎ"),
          ).toBe(true);
        });
      }).pipe(Effect.provide(Layer.mergeAll(base, SettingsSource.Default))),
    ),
  );
});
test("failed storage writes reject API callers and do not stop subsequent settings changes", () =>
  run(async (api) => {
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new Error("disk failure");
    });
    await expect(api.set("a", PATH, "mode", stringVariant("chosen"))).rejects.toThrow("disk failure");
    put.mockRestore();
    await api.set("a", PATH, "mode", stringVariant("remote"));
    expect(await api.get("a", PATH, "mode")).toEqual(stringVariant("remote"));
  }));
test("closed scopes close channels and databases, reject API writes and ignore late synchronous engine writes", async () => {
  let closedSource: SettingsSource["Service"] | undefined;
  let closedApi: SettingsApi["Service"] | undefined;
  const close = vi.spyOn(BroadcastChannel.prototype, "close");
  await run(async (api, source) => {
    closedSource = source;
    closedApi = api;
    await api.set("a", PATH, "mode", stringVariant("chosen"));
  });
  expect(close).toHaveBeenCalledOnce();
  const open = vi.spyOn(IDBFactory.prototype, "open");
  closedSource!.written({ ...instance, key: "mode", value: stringVariant("remote") });
  await expect(closedSource!.write!({ ...instance, key: "mode", value: stringVariant("remote") })).rejects.toThrow(
    "closed",
  );
  await expect(closedApi!.set("a", PATH, "mode", stringVariant("remote"))).rejects.toThrow("closed");
  expect(open).not.toHaveBeenCalled();
  await drop();
});
test("two independent page services broadcast to their own Workers with exactly one database write", () =>
  run(async (writer, _source, registry) => {
    await Effect.runPromise(registry.ensure("a"));
    await run(async (reader, _otherSource, otherRegistry, connections) => {
      await Effect.runPromise(otherRegistry.ensure("a"));
      const put = vi.spyOn(IDBObjectStore.prototype, "put");
      const post = vi.spyOn(BroadcastChannel.prototype, "postMessage");
      await writer.set("a", PATH, "mode", stringVariant("chosen"));
      await connections[0]!.untilSent("SettingChanged");
      expect(await reader.get("a", PATH, "mode")).toEqual(stringVariant("chosen"));
      expect(put).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledTimes(1);
    });
  }));
test("synchronous engine writes report asynchronous storage errors and keep processing later writes", async () => {
  const logs: EffectLogger.Options<unknown>[] = [];
  const logger = EffectLogger.make((options) => {
    logs.push(options);
  });
  const source = indexedDbSettings().pipe(Layer.provide(EffectLogger.layer([logger])));
  await run(async (api, settings) => {
    await api.schemas("a");
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new Error("engine disk failure");
    });
    settings.written({ ...instance, key: "mode", value: stringVariant("chosen") });
    settings.written({ ...instance, key: "mode", value: stringVariant("remote") });
    expect(await api.get("a", PATH, "mode")).toEqual(stringVariant("remote"));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.logLevel).toBe("Error");
    expect(logs[0]!.message).toContain("Settings change failed");
    put.mockRestore();
  }, source);
});

// Each schema stands for another module's settings.json: a path is unique within one file, not across modules.
const sharedPathSchemas: SettingsMetadata["schemas"] = [
  metadata.schemas[0]!,
  { id: "test.barrier", paths: ["/test/barrier/"], keys: [metadata.schemas[0]!.keys[1]!] },
  { id: "test.disjoint", paths: [PATH], keys: [metadata.schemas[0]!.keys[1]!] },
  {
    id: "test.alias",
    paths: [PATH],
    keys: [{ ...metadata.schemas[0]!.keys[0]!, default: { _tag: "s", value: "remote" } }],
  },
  { id: "test.incompatible", paths: [PATH], keys: [{ name: "mode", type: "i", default: { _tag: "i", value: 2 } }] },
  {
    id: "test.restricted",
    paths: [PATH],
    keys: [{ name: "mode", type: "s", default: { _tag: "s", value: "default" }, choices: ["default"] }],
  },
];
const registerShared = async (source: SettingsSource["Service"]) => {
  for (const schema of sharedPathSchemas) await source.register!({ schemas: [schema] });
};
const at = (schemaId: string) => ({ schemaId, path: PATH });
for (const origin of ["local", "remote"] as const) {
  test(`shared-path ${origin} changes skip disjoint and incompatible keys without losing valid recipients`, () =>
    run(async (api, source) => {
      await api.schemas("a");
      await registerShared(source);
      const changes: SettingsChange[] = [];
      const abort = new AbortController();
      const watching = Effect.runPromise(
        source.changes.pipe(
          Stream.runForEach((change) =>
            Effect.sync(() => {
              changes.push(change);
            }),
          ),
        ),
        { signal: abort.signal },
      );
      const other = new BroadcastChannel("ibus-web:gsettings");
      const token = Symbol("writer");
      const put = vi.spyOn(IDBObjectStore.prototype, "put");
      const post = vi.spyOn(BroadcastChannel.prototype, "postMessage");
      try {
        if (origin === "local") {
          await source.write!({ ...instance, key: "mode", value: stringVariant("chosen"), origin: token });
        } else {
          // A valid following message is a processing barrier even if the preceding change is dropped.
          const done = Effect.runPromise(
            source.changes.pipe(
              Stream.filter((change) => change.schemaId === "test.barrier" && change.key === "count"),
              Stream.take(1),
              Stream.runCollect,
            ),
            { signal: abort.signal },
          );
          other.postMessage({
            schemaPath: PATH,
            key: "mode",
            type: "s",
            bytes: encodeValue("s", { _tag: "s", value: "chosen" }).buffer,
          });
          other.postMessage({
            schemaPath: "/test/barrier/",
            key: "count",
            type: "i",
            bytes: encodeValue("i", { _tag: "i", value: 2 }).buffer,
          });
          await done;
        }
        const aliased = await source.snapshot([at("test.alias")]);
        expect(
          changes
            .filter((change) => change.key === "mode")
            .map(({ schemaId, path, value, origin }) => ({ schemaId, path, value, origin })),
        ).toEqual([
          {
            schemaId: "test.settings",
            path: PATH,
            value: stringVariant("chosen"),
            origin: origin === "local" ? token : undefined,
          },
          {
            schemaId: "test.alias",
            path: PATH,
            value: stringVariant("chosen"),
            origin: origin === "local" ? token : undefined,
          },
        ]);
        if (origin === "local") {
          expect(aliased).toEqual({ [PATH]: { mode: stringVariant("chosen") } });
          expect(await source.snapshot([at("test.disjoint")])).toEqual({ [PATH]: {} });
          // As stored, for the module's settings backend to refuse in favour of its own default.
          expect(await source.snapshot([at("test.incompatible")])).toEqual({
            [PATH]: { mode: stringVariant("chosen") },
          });
          expect(await source.snapshot([at("test.restricted")])).toEqual({ [PATH]: { mode: stringVariant("chosen") } });
          expect(put).toHaveBeenCalledTimes(1);
          expect(post).toHaveBeenCalledTimes(1);
        } else {
          expect(aliased).toEqual({ [PATH]: {} });
          expect(put).not.toHaveBeenCalled();
          expect(post).toHaveBeenCalledTimes(2);
        }
      } finally {
        other.close();
        abort.abort();
        await watching.catch(() => {});
      }
    }));
}
test("shared-path deletion notifies each local and remote alias with its own default and leaves the next snapshot empty", () =>
  run(async (api, source) => {
    await api.schemas("a");
    await registerShared(source);
    await source.write!({ ...instance, key: "mode", value: stringVariant("chosen") });
    await run(async (remoteApi, receiver) => {
      await remoteApi.schemas("a");
      await registerShared(receiver);
      const token = Symbol("writer");
      const localChanges: SettingsChange[] = [];
      const remoteChanges: SettingsChange[] = [];
      const abort = new AbortController();
      const localWatching = Effect.runPromise(
        source.changes.pipe(
          Stream.runForEach((change) =>
            Effect.sync(() => {
              localChanges.push(change);
            }),
          ),
        ),
        { signal: abort.signal },
      );
      const remoteWatching = Effect.runPromise(
        receiver.changes.pipe(
          Stream.take(4),
          Stream.runForEach((change) =>
            Effect.sync(() => {
              remoteChanges.push(change);
            }),
          ),
        ),
        { signal: abort.signal },
      );
      const put = vi.spyOn(IDBObjectStore.prototype, "put");
      const remove = vi.spyOn(IDBObjectStore.prototype, "delete");
      const post = vi.spyOn(BroadcastChannel.prototype, "postMessage");
      try {
        await source.write!({ ...instance, key: "mode", value: stringVariant("default"), origin: token });
        const expected = [
          { schemaId: "test.settings", path: PATH, key: "mode", value: stringVariant("default") },
          { schemaId: "test.alias", path: PATH, key: "mode", value: stringVariant("remote") },
          { schemaId: "test.incompatible", path: PATH, key: "mode", value: int32Variant(2) },
          { schemaId: "test.restricted", path: PATH, key: "mode", value: stringVariant("default") },
        ];
        expect(localChanges).toEqual(expected.map((change) => ({ ...change, origin: token })));
        await remoteWatching;
        expect(remoteChanges).toEqual(expected);
        for (const page of [source, receiver]) {
          for (const change of expected) expect(await page.read!(at(change.schemaId), "mode")).toEqual(change.value);
          for (const schema of sharedPathSchemas)
            expect(await page.snapshot([{ schemaId: schema.id, path: schema.paths[0]! }])).toEqual({
              [schema.paths[0]!]: {},
            });
        }
        expect(await stored()).toEqual([]);
        expect(put).not.toHaveBeenCalled();
        expect(remove).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledExactlyOnceWith({ schemaPath: PATH, key: "mode", type: "s", bytes: null });
      } finally {
        abort.abort();
        await Promise.all([localWatching.catch(() => {}), remoteWatching.catch(() => {})]);
      }
    });
  }));

// Module b declares the same path as module a under a schema that rejects "remote".
const otherMetadata: SettingsMetadata = {
  schemas: [
    {
      id: "test.other",
      paths: [PATH],
      keys: [{ name: "mode", type: "s", default: { _tag: "s", value: "default" }, choices: ["default", "chosen"] }],
    },
  ],
};
const differingOptions = {
  ...options,
  loadManifest: async (url: URL) => ({
    ...manifest,
    name: url.pathname.split("/")[1],
    settingsSchemas: url.pathname.startsWith("/b/") ? ["test.other"] : manifest.settingsSchemas,
  }),
  loadMetadata: async (url: URL) => encodeSettingsMetadata(url.pathname.startsWith("/b/") ? otherMetadata : metadata),
};
test("a value stored through one module's schema that another's rejects reaches the other's Init as stored, and its get returns the default", () =>
  run(
    async (api, _source, registry, connections) => {
      // Only module a's schema accepts "remote".
      await api.set("a", PATH, "mode", stringVariant("remote"));
      expect(await api.get("a", PATH, "mode")).toEqual(stringVariant("remote"));
      expect(await api.get("b", PATH, "mode")).toEqual(stringVariant("default"));

      await Effect.runPromise(registry.ensure("b"));
      const init = connections[0]!.sent.map(({ request }) => request).find((request) => request._tag === "Init");
      expect(init?._tag === "Init" && init.settings.find(({ path }) => path === PATH)?.values).toEqual({
        mode: stringVariant("remote"),
      });
    },
    undefined,
    differingOptions,
  ));

test("modules declaring different schemas at one path each receive only their own schema's changes", () =>
  run(
    async (api, _source, registry, connections) => {
      await Effect.runPromise(registry.ensure("a"));
      await Effect.runPromise(registry.ensure("b"));
      const changed = (connection: DomConnection) =>
        connection.sent
          .map(({ request }) => request)
          .filter((request) => request._tag === "SettingChanged")
          .map(({ path, key, value }) => ({ path, key, value }));
      connections[0]!.sent.length = 0;
      connections[1]!.sent.length = 0;
      // Only module a's schema accepts "remote".
      await api.set("a", PATH, "mode", stringVariant("remote"));
      await connections[0]!.untilSent("SettingChanged");
      await api.set("a", PATH, "mode", stringVariant("chosen"));
      await connections[1]!.untilSent("SettingChanged");
      await vi.waitFor(() => expect(changed(connections[0]!)).toHaveLength(2));
      expect(changed(connections[0]!)).toEqual([
        { path: PATH, key: "mode", value: stringVariant("remote") },
        { path: PATH, key: "mode", value: stringVariant("chosen") },
      ]);
      expect(changed(connections[1]!)).toEqual([{ path: PATH, key: "mode", value: stringVariant("chosen") }]);
    },
    undefined,
    differingOptions,
  ));
