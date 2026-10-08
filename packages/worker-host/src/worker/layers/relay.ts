// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Word } from "@ibus-web/protocol/transport";
import { Context, Effect, Layer } from "effect";
import { postCrash } from "../../shared/control.ts";
import { startupFailed, type StartupFailed } from "../failure.ts";
import type { RelayInit } from "../forward.ts";
import { HostRuntime } from "./runtime.ts";
import { HostWorker } from "./worker.ts";

// Captured before the runtime is imported: under Node, Emscripten replaces
// the global with worker_threads' own Worker class.
const SpawnWorker: typeof Worker = globalThis.Worker;

// The wake relay: the page bumps the control buffer's wake word, which the
// host, asleep in the runtime, doesn't sleep on. It bumps a word in the
// runtime's memory, so it starts once the runtime has one, and it ends with
// the runtime's scope.
interface RelayShape {
  // Settles with the relay's error, which this thread hears only in its
  // event loop.
  readonly failed: Promise<string>;
}

export class Relay extends Context.Service<Relay, RelayShape>()("@ibus-web/worker-host/Relay") {}

const startRelay = (url: URL, init: RelayInit): Promise<Worker> =>
  new Promise((resolve, reject) => {
    const relay = new SpawnWorker(url, { type: "module", name: "ibus-web-relay" });
    relay.onmessage = () => resolve(relay);
    relay.onerror = (event) => reject(new Error(`relay: ${event.message}`));
    relay.postMessage(init);
  });

export const relayLayer: Layer.Layer<Relay, StartupFailed, HostWorker | HostRuntime> = Layer.effect(
  Relay,
  Effect.gen(function* () {
    const { init, env, control } = yield* HostWorker;
    const { handle, wakeIndex } = yield* HostRuntime;

    const relay = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          startRelay(env.relayUrl, {
            from: { buffer: init.control, index: Word.wake },
            to: { buffer: handle.memory.buffer as unknown as SharedArrayBuffer, index: wakeIndex },
            control: init.control,
            ...(init.layout === undefined ? {} : { layout: init.layout }),
          }),
        catch: startupFailed,
      }),
      (relay) => Effect.sync(() => relay.terminate()),
    );

    // The relay reports its own failure through the control buffer; one this
    // thread does hear of, in its event loop, is reported the same way.
    const failed = new Promise<string>((resolve) => {
      relay.onerror = (event) => {
        resolve(event.message);
        postCrash(control);
        Atomics.add(handle.words, wakeIndex, 1);
        Atomics.notify(handle.words, wakeIndex);
      };
    });
    return { failed };
  }),
);
