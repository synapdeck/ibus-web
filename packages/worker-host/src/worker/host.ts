// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The Worker host as a scoped program. Its resources are layers, each a
// scope inside the last. The Worker scope (the control buffer, the logger,
// crash reporting) reads the manifest, whose kind decides the rest. For a
// WebAssembly module they are the storage's plan (the locks, and what to
// mount, which sizes the runtime's memory), the runtime (instantiated in a
// memory made for it), the wake relay, which bumps a word in that memory,
// the storage's mounts, and the engine module; only this Worker, and the
// relay it starts, touch the runtime's memory. A JavaScript module's script
// is the only scope inside the Worker's: it runs on this thread, which
// sleeps on the control buffer's own wake word. The request loop then runs
// as one synchronous section, leaving it only to top the pthread pool up or
// to take the page's messages.

import type { JsModuleManifest } from "@ibus-web/protocol";
import { Effect, Layer } from "effect";
import type { HostInit, HostMessage } from "../shared/messages.ts";
import type { HostConfig } from "./config.ts";
import { runtimeCallFailed, StartupFailed, startupFailed } from "./failure.ts";
import { Instruments } from "./instruments.ts";
import { jsBackend } from "./js-backend.ts";
import { relayLayer, Relay } from "./layers/relay.ts";
import { HostRuntime, runtimeLayer } from "./layers/runtime.ts";
import { HostScript, scriptLayer } from "./layers/script.ts";
import { Storage, storageLayer } from "./layers/storage.ts";
import { PlannedStorage, storagePlanLayer } from "./layers/storage-plan.ts";
import { HostWorker, workerLayer, type WorkerEnv } from "./layers/worker.ts";
import { runtimeBackend } from "./runtime-backend.ts";
import { serve } from "./serve.ts";
import { readManifest, readRuntimeConstants, type StartingModule } from "./startup.ts";

type StartingWasm = Extract<StartingModule, { kind: "wasm" }>;

// Every scope a WebAssembly module runs in inside the Worker's, outermost
// last.
export const runtimeHostLayer = (
  starting: StartingWasm,
): Layer.Layer<PlannedStorage | HostRuntime | Relay | Storage, StartupFailed, HostWorker | HostConfig> =>
  storageLayer.pipe(
    Layer.provideMerge(relayLayer),
    Layer.provideMerge(runtimeLayer),
    Layer.provideMerge(storagePlanLayer(starting)),
  );

const startingModule: Effect.Effect<StartingModule, StartupFailed, HostWorker> = Effect.gen(function* () {
  const { init } = yield* HostWorker;
  return yield* Effect.tryPromise({
    try: () => readManifest(init, () => readRuntimeConstants(init.runtimeUrl)),
    catch: (error) => (error instanceof StartupFailed ? error : startupFailed(error)),
  });
});

// An install-only host's work once its storage has installed the base
// data: each engine's own, as PrepareEngine installs it, each answered with
// "prepared".
const installEngines = (engines: readonly string[]): Effect.Effect<void, StartupFailed, Storage> =>
  Effect.gen(function* () {
    const storage = yield* Storage;
    for (const engine of engines)
      yield* Effect.tryPromise({ try: () => storage.prepare(engine), catch: runtimeCallFailed });
  });

const serveRuntime = Effect.gen(function* () {
  const runtime = yield* HostRuntime;
  const relay = yield* Relay;
  const storage = yield* Storage;
  const { module, constants } = yield* PlannedStorage;
  const instruments = yield* Instruments;
  return yield* serve({
    backend: (ring) => runtimeBackend({ runtime, constants, module, instruments, ring }),
    storage,
    relayFailed: relay.failed,
  });
});

// A WebAssembly module's host; an install-only one says "preloaded" once
// every scope inside the Worker's has closed.
const runtimeHost = (init: HostInit<WebAssembly.Module, unknown>, starting: StartingWasm) =>
  init.install === undefined
    ? Effect.gen(function* () {
        const worker = yield* HostWorker;
        worker.ready();
        return yield* serveRuntime;
      }).pipe(Effect.provide(runtimeHostLayer(starting)))
    : installEngines(init.install.engines).pipe(
        Effect.provide(runtimeHostLayer(starting)),
        Effect.andThen(Effect.flatMap(HostWorker, ({ env }) => Effect.sync(() => env.post({ type: "preloaded" })))),
      );

// A JavaScript module has no data, so each of its engines is prepared as
// soon as the page asks.
const prepareNothing =
  (manifest: JsModuleManifest, post: (message: HostMessage) => void) =>
  async (engine: string): Promise<void> =>
    post({
      type: "prepared",
      engine,
      ...(manifest.engines.some(({ name }) => name === engine)
        ? {}
        : { error: `module ${manifest.name} has no engine ${engine}` }),
    });

const serveScript = Effect.gen(function* () {
  const { control, env } = yield* HostWorker;
  const { manifest, script } = yield* HostScript;
  return yield* serve({
    backend: (ring) => jsBackend({ manifest, script, control, ring }),
    storage: { closed: () => false, quotaFailures: () => 0, prepare: prepareNothing(manifest, env.post) },
    // No relay runs beside a JavaScript module.
    relayFailed: new Promise(() => {}),
  });
});

// A JavaScript module's host. An install-only one has nothing to install,
// so it imports no script.
const scriptHost = ({ install }: HostInit<WebAssembly.Module, unknown>, manifest: JsModuleManifest) =>
  install === undefined
    ? Effect.gen(function* () {
        const worker = yield* HostWorker;
        worker.ready();
        return yield* serveScript;
      }).pipe(Effect.provide(scriptLayer(manifest)))
    : Effect.gen(function* () {
        const { env } = yield* HostWorker;
        const prepare = prepareNothing(manifest, env.post);
        for (const engine of install.engines) yield* Effect.promise(() => prepare(engine));
        env.post({ type: "preloaded" });
      });

// The host: starts every scope, says it is ready, then serves until the
// module stops. An install-only host installs instead, and says
// "preloaded" once done. Failures are reported to the page as the Worker
// scope closes, so the program itself never fails.
export const program = (
  init: HostInit<WebAssembly.Module, unknown>,
  env: WorkerEnv,
): Effect.Effect<void, never, HostConfig> =>
  Effect.gen(function* () {
    const starting = yield* startingModule;
    return yield* starting.kind === "js" ? scriptHost(init, starting.manifest) : runtimeHost(init, starting);
  }).pipe(Effect.provide(workerLayer(init, env)), Effect.ignore);
