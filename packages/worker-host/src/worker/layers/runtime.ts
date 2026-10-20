// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Context, Effect, Layer } from "effect";
import { WASM_PAGE } from "../../shared/messages.ts";
import { runtimeCallFailed, startupFailed, type StartupFailed } from "../failure.ts";
import { Instruments } from "../instruments.ts";
import {
  alloc,
  check,
  checkMemory,
  requireRuntime,
  type CreateRuntime,
  type Runtime,
  type RuntimeHandle,
} from "../runtime.ts";
import { PlannedStorage } from "./storage-plan.ts";
import { HostWorker } from "./worker.ts";

// The runtime scope: the runtime, started in a memory the host makes at the
// engine's size, and set up to pump on this thread. Nothing to release: the
// runtime ends with the Worker.
export interface HostRuntimeShape {
  readonly handle: RuntimeHandle;
  readonly wakeIndex: number;
  // Where requests and replies sit in the runtime's memory, each the
  // control slot's size.
  readonly buffers: { readonly request: number; readonly reply: number; readonly cap: number };
}

export class HostRuntime extends Context.Service<HostRuntime, HostRuntimeShape>()(
  "@ibus-web/worker-host/HostRuntime",
) {}

export const runtimeLayer: Layer.Layer<HostRuntime, StartupFailed, HostWorker | PlannedStorage> = Layer.effect(
  HostRuntime,
  Effect.gen(function* () {
    const { init, control } = yield* HostWorker;
    const { memory: bytes, manifest, constants } = yield* PlannedStorage;
    const instruments = yield* Instruments;

    yield* Effect.try({ try: () => checkMemory(bytes, constants.memory), catch: startupFailed });
    const memory = new WebAssembly.Memory({
      initial: bytes.initial / WASM_PAGE,
      maximum: bytes.maximum / WASM_PAGE,
      shared: true,
    });

    instruments.beforeRuntime();
    const { default: createRuntime } = yield* Effect.tryPromise({
      try: () => import(/* @vite-ignore */ init.runtimeUrl) as Promise<{ default: CreateRuntime }>,
      catch: startupFailed,
    });
    const { wasm } = init;
    const rt: Runtime = yield* Effect.tryPromise({
      try: () => {
        // Emscripten has no way to hear that instantiateWasm failed, so a
        // failure ends the wait for the runtime here instead.
        let failInstantiate: (error: unknown) => void = () => {};
        const instantiateFailed = new Promise<never>((_, reject) => {
          failInstantiate = reject;
        });

        return Promise.race([
          createRuntime({
            wasmMemory: memory,
            ibuswebEngineThreads: init.install === undefined ? manifest.threads : 0,
            ...(wasm === undefined
              ? {}
              : {
                  instantiateWasm: (imports, done) => {
                    WebAssembly.instantiate(wasm, imports).then((instance) => done(instance, wasm), failInstantiate);
                    return {};
                  },
                }),
          }),
          instantiateFailed,
        ]);
      },
      catch: startupFailed,
    });

    return yield* Effect.try({
      try: () => {
        requireRuntime(rt);
        const handle: RuntimeHandle = {
          rt,
          memory,
          bytes: rt.HEAPU8,
          words: new Int32Array(rt.HEAPU8.buffer),
          fs: constants.fs,
        };
        instruments.runtimeStarted(handle);

        const wake = alloc(handle, 4);
        Atomics.store(handle.words, wake / 4, 0);
        check("ibusweb_runtime_init", rt._ibusweb_runtime_init(wake));

        const cap = control.slot.length;
        return {
          handle,
          wakeIndex: wake / 4,
          buffers: { request: alloc(handle, cap), reply: alloc(handle, cap), cap },
        };
      },
      catch: runtimeCallFailed,
    });
  }),
);
