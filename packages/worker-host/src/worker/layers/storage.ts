// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { errorReport } from "@ibus-web/protocol";
import { Context, Effect, Layer } from "effect";
import { engineDir, engineWriterLock } from "../../shared/naming.ts";
import { HostConfig } from "../config.ts";
import { runtimeCallFailed, runtimeFinalizer, type StartupFailed } from "../failure.ts";
import { Instruments } from "../instruments.ts";
import { provideData } from "../install/provide.ts";
import { setEnvironment } from "../environment.ts";
import { mount, type MountedStorage } from "../storage/mount.ts";
import { HostRuntime } from "./runtime.ts";
import { PlannedStorage } from "./storage-plan.ts";
import { HostWorker } from "./worker.ts";

// The storage's mounts: the engine's own files at its directory, and its
// data, installed first if need be, at /nix/store. The backends' threads and
// connections end with the Worker, since WasmFS never destroys a backend;
// released while the runtime can still be called, it seals the read-write
// backends, which lets the writer lock go.
export class Storage extends Context.Service<Storage, MountedStorage>()("@ibus-web/worker-host/Storage") {}

export const storageLayer: Layer.Layer<Storage, StartupFailed, HostWorker | HostRuntime | PlannedStorage | HostConfig> =
  Layer.effect(
    Storage,
    Effect.gen(function* () {
      const { env } = yield* HostWorker;
      const { handle } = yield* HostRuntime;
      const { plan, held, manifest, constants } = yield* PlannedStorage;
      const config = yield* HostConfig;
      const instruments = yield* Instruments;

      const mounted = yield* Effect.tryPromise({
        try: () => mount(handle, plan, engineDir(manifest)),
        catch: runtimeCallFailed,
      });
      const { seal } = mounted;
      if (seal !== undefined) {
        held.sealWith(() => instruments.seal(seal));
        yield* runtimeFinalizer(
          Effect.suspend(() => {
            try {
              held.seal();
              return Effect.void;
            } catch (error) {
              return Effect.logError(
                `sealing the engine's user data failed, so this host keeps ${engineWriterLock(manifest)} until its Worker ends: ${errorReport(error)}`,
              );
            }
          }),
        );
      }

      if (plan.mount === "memory") env.post({ type: "storage", state: "ephemeral", message: plan.why });
      if ((plan.mount === "indexeddb" || plan.mount === "node") && plan.readOnly)
        env.post({
          type: "storage",
          state: "read-only",
          message: `another instance of engine ${manifest.name} holds ${engineWriterLock(manifest)}; this one's user data refuses changes${plan.mount === "node" ? " (in browsers; the Node backend has no read-only mode)" : ""}`,
        });

      const data = yield* provideData({
        handle,
        engine: manifest,
        plan,
        idbReadOnly: constants.idbReadOnly,
        held,
        config,
        instruments,
        post: env.post,
      });
      const storage: MountedStorage = { ...mounted, closed: () => mounted.closed() || data.closed() };

      yield* Effect.try({ try: () => setEnvironment(handle, manifest), catch: runtimeCallFailed });
      yield* Effect.try({ try: () => instruments.storageMounted(storage), catch: runtimeCallFailed });
      return storage;
    }),
  );
