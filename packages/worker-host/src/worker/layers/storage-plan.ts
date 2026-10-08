// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { ModuleManifest } from "@ibus-web/protocol";
import { Context, Effect, Layer } from "effect";
import type { RuntimeMemory } from "../../shared/messages.ts";
import { StartupFailed, startupFailed } from "../failure.ts";
import { Instruments } from "../instruments.ts";
import { fetchBytes, readManifest, readRuntimeConstants, type RuntimeDistributionConstants } from "../startup.ts";
import { Held } from "../storage/held.ts";
import { memoryFor, planStorage, type StoragePlan } from "../storage/plan.ts";
import { HostWorker } from "./worker.ts";

// The storage's plan: what to mount at the engine's directory, decided
// before the runtime's memory is made, since a mount in memory needs a
// larger one, and the locks, among them the engine's writer lock, which the
// host takes before it creates its user backend. Released, it lets go of
// every lock, but of the writer lock only once the user backend is sealed.
interface PlannedStorageShape {
  readonly constants: RuntimeDistributionConstants;
  readonly plan: StoragePlan;
  readonly held: Held;
  // The runtime's memory, in bytes.
  readonly memory: RuntimeMemory;
  readonly manifest: ModuleManifest;
  readonly module: ArrayBuffer;
}

export class PlannedStorage extends Context.Service<PlannedStorage, PlannedStorageShape>()(
  "@ibus-web/worker-host/PlannedStorage",
) {}

export const storagePlanLayer: Layer.Layer<PlannedStorage, StartupFailed, HostWorker> = Layer.effect(
  PlannedStorage,
  Effect.gen(function* () {
    const { init } = yield* HostWorker;
    const instruments = yield* Instruments;

    const constants = yield* Effect.tryPromise({
      try: () => readRuntimeConstants(init.runtimeUrl),
      catch: startupFailed,
    });
    const manifest = yield* Effect.tryPromise({
      try: () => readManifest(init, constants),
      catch: (error) => (error instanceof StartupFailed ? error : startupFailed(error)),
    });

    const held = new Held();
    yield* Effect.addFinalizer(() => Effect.sync(() => held.releaseAll()));
    instruments.beforeProbe();
    const plan = yield* Effect.tryPromise({
      try: () => planStorage(init.storage, manifest, constants.idbReadOnly, held),
      catch: startupFailed,
    });

    const module = yield* Effect.tryPromise({ try: () => fetchBytes(manifest.module.url), catch: startupFailed });
    if (module.length !== manifest.module.size)
      return yield* new StartupFailed({ message: `module size ${module.length}, expected ${manifest.module.size}` });

    return {
      constants,
      plan,
      held,
      manifest,
      module: module.buffer as ArrayBuffer,
      memory: memoryFor({ initial: manifest.memory, maximum: manifest.memory }, plan, manifest),
    };
  }),
);
