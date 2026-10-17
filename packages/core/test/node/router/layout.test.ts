// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import { stringVariant, type ModuleManifest } from "@ibus-web/protocol";
import { makeModuleRegistry } from "../../../src/services/modules.ts";
import { CoreConfig } from "../../../src/services/config.ts";
import { SettingsSource, type SettingsSnapshot } from "../../../src/services/settings.ts";
import { Logger, PanelEvents, type LogLine } from "../../../src/services/logging.ts";
import { layoutMetadata, layoutPath } from "../../../src/settings/layout.ts";
import { FakeConnection, fixture, key } from "../../shared/router.ts";

const dataPath = `/nix/store/${"a".repeat(32)}-test`;
const engine = (name: string, layout: "us" | "default") => ({
  name,
  displayName: name,
  languages: [],
  keyboard: { layout, passThrough: [] },
});
const manifest: ModuleManifest = {
  name: "dist",
  version: "1",
  license: "MIT",
  runtimeAbi: 1,
  runtimeIdentity: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  protocol: 1,
  module: { url: "engine.so", size: 1 },
  memory: 65536,
  threads: 0,
  data: [{ storePath: dataPath, url: "data.tar", size: 0, files: 1, encoding: "identity" }],
  settingsSchemaDir: `${dataPath}/schemas`,
  engines: [engine("test", "us"), engine("rime:luna_pinyin", "us"), engine("free", "default")],
  settingsSchemas: [],
};
const path = "/org/ibus-web/keyboard/dist/test/";
const url = new URL("https://example.test/");
const emptyReply = { ret: 0, outSeq: 0, records: [] };

// AZERTY's A key: the character a, at the place US's Q is.
const azertyA = () => ({ ...key("a"), code: "KeyQ" }) as unknown as KeyboardEvent;

const registryWith = (started: FakeConnection[]) =>
  makeModuleRegistry({
    hostUrl: url,
    runtimeUrl: url,
    modules: { test: url },
    loadManifest: async () => manifest,
    start: async () => {
      const connection = new FakeConnection();
      connection.requestAsync = async () => emptyReply;
      started.push(connection);
      return connection;
    },
  });

// The keyval the engine was sent for a key typed into a ready context of the engine `test`.
const typed = (registry: Effect.Success<ReturnType<typeof registryWith>>, connection: FakeConnection) => {
  const f = fixture();
  f.context.generation = registry.snapshot("test")!.generation;
  const unregister = registry.registerContext("test", f.context);
  connection.sent.length = 0;
  registry.keySink("test", f.context).key(azertyA());
  unregister();
  const request = connection.sent.find((sent) => sent.request._tag === "ProcessKeyEvent")?.request;
  return request?._tag === "ProcessKeyEvent" ? request.keyval : undefined;
};

const services = (initial: SettingsSnapshot = {}) =>
  Layer.mergeAll(CoreConfig.Default, SettingsSource.layer(initial), Logger.Default, PanelEvents.Default);

it("places each engine's setting under its distribution and name, and gives none to a name no path can hold", () => {
  expect(layoutPath("rime", "rime:luna_pinyin")).toBe("/org/ibus-web/keyboard/rime/rime/luna_pinyin/");
  expect(layoutPath("dist", "a/b")).toBeUndefined();
  expect(layoutPath("dist", "a::b")).toBeUndefined();
  expect(layoutPath("dist", "..")).toBeUndefined();
  expect(layoutMetadata(manifest)).toMatchObject({
    schemas: [
      {
        id: "org.ibus-web.keyboard.us",
        paths: [path, "/org/ibus-web/keyboard/dist/rime/luna_pinyin/"],
        keys: [{ name: "layout", type: "s", default: { value: "us" }, choices: ["us", "default"] }],
      },
      {
        id: "org.ibus-web.keyboard.default",
        paths: ["/org/ibus-web/keyboard/dist/free/"],
        keys: [{ name: "layout", default: { value: "default" } }],
      },
    ],
  });
});

it.effect("engines report their declared layouts and the settings' paths while nothing is stored", () =>
  Effect.gen(function* () {
    const registry = yield* registryWith([]);
    expect(yield* registry.engines("test")).toMatchObject([
      { name: "test", keyboard: { layout: "us" }, layout: "us", layoutPath: path },
      { name: "rime:luna_pinyin", layout: "us", layoutPath: "/org/ibus-web/keyboard/dist/rime/luna_pinyin/" },
      { name: "free", layout: "default", layoutPath: "/org/ibus-web/keyboard/dist/free/" },
    ]);
  }).pipe(Effect.provide(services())),
);

it.effect("a stored layout applies from the module's first key", () =>
  Effect.gen(function* () {
    const started: FakeConnection[] = [];
    const registry = yield* registryWith(started);
    yield* registry.select("test");
    expect((yield* registry.engines("test"))[0]).toMatchObject({ keyboard: { layout: "us" }, layout: "default" });
    expect(typed(registry, started[0]!)).toBe(0x61);
  }).pipe(Effect.provide(services({ [path]: { layout: stringVariant("default") } }))),
);

it.effect("a changed layout applies to the next key, and to engines' listing", () =>
  Effect.gen(function* () {
    const settings = yield* SettingsSource;
    const started: FakeConnection[] = [];
    const registry = yield* registryWith(started);
    yield* registry.select("test");
    expect(typed(registry, started[0]!), "the US layout's Q").toBe(0x71);

    settings.written({
      schemaId: "org.ibus-web.keyboard.us",
      path,
      key: "layout",
      value: stringVariant("default"),
    });
    // The change reaches the registry through the source's stream, a few turns later.
    for (let turn = 0; turn < 100 && registry.snapshot("test")!.keyboards.get("test")!.layout === "us"; turn++)
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(typed(registry, started[0]!)).toBe(0x61);
    expect((yield* registry.engines("test"))[0]!.layout).toBe("default");
    expect(started[0]!.sent.some((sent) => sent.request._tag === "SettingChanged")).toBe(false);
  }).pipe(Effect.provide(services())),
);

it.effect("a layout changed while the stored layouts are read applies over what the read returned", () =>
  Effect.gen(function* () {
    const settings = yield* SettingsSource;
    let reading!: () => void;
    const read = new Promise<void>((resolve) => (reading = resolve));
    let finish!: () => void;
    const held = new Promise<void>((resolve) => (finish = resolve));
    const registry = yield* registryWith([]).pipe(
      Effect.provideService(SettingsSource, {
        ...settings,
        snapshot: async (instances) => {
          const stored = await settings.snapshot(instances);
          reading();
          await held;
          return stored;
        },
      }),
    );
    const listing = yield* registry.engines("test").pipe(Effect.forkScoped);

    yield* Effect.promise(() => read);
    settings.written({
      schemaId: "org.ibus-web.keyboard.us",
      path,
      key: "layout",
      value: stringVariant("default"),
    });
    // The change reaches the registry through the source's stream, a few turns later.
    for (let turn = 0; turn < 10; turn++) yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
    finish();

    expect((yield* Fiber.join(listing))[0]!.layout).toBe("default");
  }).pipe(Effect.provide(services())),
);

it.effect("a settings source that can't read the layouts leaves the declared ones and warns", () =>
  Effect.gen(function* () {
    const lines: LogLine[] = [];
    const started: FakeConnection[] = [];
    const registry = yield* registryWith(started).pipe(
      Effect.provide(
        Layer.mergeAll(
          CoreConfig.Default,
          PanelEvents.Default,
          Layer.succeed(Logger, { enqueue: (line) => lines.push(line) }),
          Layer.succeed(SettingsSource, {
            snapshot: async () => {
              throw new Error("store closed");
            },
            written: () => {},
            changes: Stream.empty,
          }),
        ),
      ),
    );
    expect((yield* registry.engines("test"))[0]!.layout).toBe("us");
    expect(lines).toMatchObject([{ module: "test", record: { level: 16, domain: "page-settings" } }]);
    expect(lines[0]!.record.message).toContain("store closed");
  }),
);
