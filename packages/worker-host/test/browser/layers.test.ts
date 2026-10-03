// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The host's configuration and its Worker scope, as layers, without a
// runtime: what the scope reports when it closes after a failure, and that
// finalizers calling into the runtime run on a normal close only.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Scope } from "effect";
import { createControl, State, Word } from "../../src/shared/control.ts";
import type { HostInit, HostMessage } from "../../src/shared/messages.ts";
import { defaultHostConfig, HostConfig } from "../../src/worker/config.ts";
import {
  HostWorker,
  RelayFailed,
  RuntimeStopped,
  runtimeFinalizer,
  StartupFailed,
  workerLayer,
  type HostWorkerShape,
  type UncaughtError,
  type WorkerEnv,
} from "../../src/worker/host.ts";

describe("HostConfig", () => {
  it.effect("holds the defaults, of which a test may shorten some", () =>
    Effect.gen(function* () {
      expect(yield* HostConfig.pipe(Effect.provide(HostConfig.layer))).toEqual(defaultHostConfig);
      const shortened = yield* HostConfig.pipe(Effect.provide(HostConfig.layerWith({ topUpLimitMs: 5 })));
      expect(shortened).toEqual({ ...defaultHostConfig, topUpLimitMs: 5 });
      expect(defaultHostConfig).toMatchObject({
        topUpLimitMs: 10_000,
        lockRoundMs: 1000,
        lockLimitMs: 120_000,
        progressIntervalMs: 1000,
        archiveIdleMs: 30_000,
        deleteLimitMs: 10_000,
      });
    }),
  );
});

describe("runtimeFinalizer", () => {
  const closing = (exit: Exit.Exit<unknown, unknown>) =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const scope = yield* Scope.make();
      yield* Scope.provide(scope)(runtimeFinalizer(Effect.sync(() => calls.push("runtime"))));
      yield* Scope.provide(scope)(Effect.addFinalizer(() => Effect.sync(() => calls.push("JavaScript"))));
      yield* Scope.close(scope, exit);
      return calls;
    });

  it.effect("calls into the runtime on a normal close", () =>
    Effect.gen(function* () {
      expect(yield* closing(Exit.void)).toEqual(["JavaScript", "runtime"]);
    }),
  );

  it.effect("leaves the runtime alone after a failure, but not the rest", () =>
    Effect.gen(function* () {
      expect(yield* closing(Exit.fail(new RuntimeStopped({ error: "unwind" })))).toEqual(["JavaScript"]);
    }),
  );
});

describe("the Worker scope", () => {
  const init = (): HostInit<WebAssembly.Module, unknown> => ({
    runtimeUrl: "",
    memory: { initial: 0, maximum: 0 },
    control: createControl(),
    sides: [],
    engine: { name: "test", version: "0", data: [] },
    poolLowWater: 0,
    constants: { pumpError: 0, waitTimedOut: 0, memory: { minimum: 0, maximum: 0 } },
  });

  // Builds the scope, runs use() in it, then closes it with use()'s exit;
  // returns what the scope posted and the control buffer's state.
  const run = (
    use: (worker: HostWorkerShape, uncaught: (event: UncaughtError) => void) => Effect.Effect<void, unknown>,
  ) =>
    Effect.gen(function* () {
      const posted: HostMessage[] = [];
      let uncaught: (event: UncaughtError) => void = () => {};
      const host = init();
      const env: WorkerEnv = {
        post: (message) => posted.push(message),
        onUncaughtError: (listener) => {
          uncaught = listener;
        },
        relayUrl: new URL("relay.js", location.href),
      };
      const layer = workerLayer(host, env).pipe(Layer.provide(HostConfig.layerWith({ crashWaitMs: 200 })));
      yield* Effect.exit(
        Effect.gen(function* () {
          yield* use(yield* HostWorker, uncaught);
        }).pipe(Effect.provide(layer)),
      );
      return { posted, state: Atomics.load(new Int32Array(host.control, 0, 16), Word.state) };
    });

  it.live("reports a failure before ready as a failed start, the control buffer left alone", () =>
    Effect.gen(function* () {
      const { posted, state } = yield* run(() => new StartupFailed({ message: "no runtime" }));
      expect(posted).toEqual([{ type: "error", message: "no runtime" }]);
      expect(state).toBe(State.idle);
    }),
  );

  it.live("reports a failure after ready as a crash, CRASHED written", () =>
    Effect.gen(function* () {
      const { posted, state } = yield* run((worker) =>
        Effect.gen(function* () {
          worker.ready();
          return yield* new RelayFailed({ message: "gone" });
        }),
      );
      expect(posted).toEqual([
        { type: "ready", startupMs: expect.any(Number) },
        { type: "crashed", message: "relay: gone" },
      ]);
      expect(state).toBe(State.crashed);
    }),
  );

  it.live("reports the thread's error that arrives after Emscripten unwinds the host", () =>
    Effect.gen(function* () {
      let prevented = false;
      const { posted } = yield* run((worker, uncaught) =>
        Effect.gen(function* () {
          worker.ready();
          worker.crashed();
          setTimeout(() => uncaught({ error: "the thread's trap", preventDefault: () => (prevented = true) }), 10);
          return yield* new RuntimeStopped({ error: "unwind" });
        }),
      );
      expect(posted.at(-1)).toEqual({ type: "crashed", message: "a thread crashed: the thread's trap" });
      expect(prevented).toBe(true);
    }),
  );

  it.live("says so when the thread's error never arrives", () =>
    Effect.gen(function* () {
      const { posted } = yield* run((worker) =>
        Effect.gen(function* () {
          worker.ready();
          return yield* new RuntimeStopped({ error: "unwind" });
        }),
      );
      expect(posted.at(-1)).toEqual({ type: "crashed", message: "a thread crashed: its error never arrived" });
    }),
  );

  it.live("leaves an uncaught error alone while the host runs", () =>
    Effect.gen(function* () {
      let prevented = false;
      yield* run((worker, uncaught) =>
        Effect.sync(() => {
          worker.ready();
          uncaught({ error: "not ours", preventDefault: () => (prevented = true) });
        }),
      );
      expect(prevented).toBe(false);
    }),
  );

  it.live("sends log records to the page", () =>
    Effect.gen(function* () {
      const { posted } = yield* run(() => Effect.logWarning("pool", "low"));
      expect(posted).toEqual([{ type: "log", level: "Warn", message: "pool low" }]);
    }),
  );

  it.live("reports a defect as a crash, with its cause", () =>
    Effect.gen(function* () {
      const { posted } = yield* run((worker) =>
        Effect.gen(function* () {
          worker.ready();
          return yield* Effect.die(new Error("a bug"));
        }),
      );
      const crash = posted.at(-1);
      expect(crash?.type).toBe("crashed");
      expect(crash?.type === "crashed" && crash.message).toContain("a bug");
    }),
  );
});
