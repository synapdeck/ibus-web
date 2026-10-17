// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The Worker host as a scoped program. Its resources are layers, each a
// scope inside the last: the Worker (the control buffer, the logger, crash
// reporting), the storage's plan (the locks, and what to mount, which sizes
// the runtime's memory), the runtime (instantiated in a memory made for it),
// the wake relay, which bumps a word in that memory, the storage's mounts,
// and the engine module. The request loop then runs as one synchronous
// section, leaving it only to top the pthread pool up. Only this Worker, and
// the relay it starts, touch the runtime's memory.

import { Effect, Layer } from "effect";
import type { HostInit } from "../shared/messages.ts";
import type { HostConfig } from "./config.ts";
import { runtimeCallFailed, type StartupFailed } from "./failure.ts";
import { relayLayer, type Relay } from "./layers/relay.ts";
import { runtimeLayer, type HostRuntime } from "./layers/runtime.ts";
import { Storage, storageLayer } from "./layers/storage.ts";
import { storagePlanLayer, type PlannedStorage } from "./layers/storage-plan.ts";
import { HostWorker, workerLayer, type WorkerEnv } from "./layers/worker.ts";
import { serve } from "./serve.ts";

// Every scope the host runs in, outermost last.
export const hostLayer = (
  init: HostInit<WebAssembly.Module, unknown>,
  env: WorkerEnv,
): Layer.Layer<HostWorker | PlannedStorage | HostRuntime | Relay | Storage, StartupFailed, HostConfig> =>
  storageLayer.pipe(
    Layer.provideMerge(relayLayer),
    Layer.provideMerge(runtimeLayer),
    Layer.provideMerge(storagePlanLayer),
    Layer.provideMerge(workerLayer(init, env)),
  );

// An install-only host's work once its storage has installed the base
// data: each engine's own, as PrepareEngine installs it, each answered with
// "prepared".
const installEngines = (engines: readonly string[]): Effect.Effect<void, StartupFailed, Storage> =>
  Effect.gen(function* () {
    const storage = yield* Storage;
    for (const engine of engines)
      yield* Effect.tryPromise({ try: () => storage.prepare(engine), catch: runtimeCallFailed });
  });

// The host: starts every scope, says it is ready, then serves until the
// runtime stops. An install-only host installs instead, and says
// "preloaded" once every scope has closed. Failures are reported to the
// page as the Worker scope closes, so the program itself never fails.
export const program = (
  init: HostInit<WebAssembly.Module, unknown>,
  env: WorkerEnv,
): Effect.Effect<void, never, HostConfig> =>
  init.install === undefined
    ? Effect.gen(function* () {
        const worker = yield* HostWorker;
        worker.ready();
        return yield* serve;
      }).pipe(Effect.provide(hostLayer(init, env)), Effect.ignore)
    : installEngines(init.install.engines).pipe(
        Effect.provide(hostLayer(init, env)),
        Effect.andThen(Effect.sync(() => env.post({ type: "preloaded" }))),
        Effect.ignore,
      );
