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

import { Cause, Context, Data, Effect, Exit, Layer, Logger, type Scope } from "effect";
import { engineDir, engineWriterLock } from "../shared/naming.ts";
import { controlViews, postCrash, postReply, Word, type ControlViews } from "../shared/control.ts";
import { WASM_PAGE, type HostInit, type HostMessage } from "../shared/messages.ts";
import { HostConfig } from "./config.ts";
import { Held } from "./storage/held.ts";
import { requestLock } from "./storage/locks.ts";
import { mount, type MountedStorage } from "./storage/mount.ts";
import { memoryFor, planStorage, type StoragePlan } from "./storage/plan.ts";
import type { RelayInit } from "./forward.ts";
import { Instruments, type InstrumentReply } from "./instruments.ts";
import { serveUntilExcursion, step, topUp, type LoopContext } from "./loop.ts";
import {
  alloc,
  check,
  checkMemory,
  loadSides,
  requireRuntime,
  RuntimeRefused,
  type CreateRuntime,
  type Runtime,
  type RuntimeHandle,
} from "./runtime.ts";

// Captured before the runtime is imported: under Node, Emscripten replaces
// the global with worker_threads' own Worker class.
const SpawnWorker: typeof Worker = globalThis.Worker;

// What Emscripten throws to unwind the runtime's thread once another thread
// has crashed. That thread's own error reaches this one's event loop only
// afterwards, as an uncaught error.
const UNWIND = "unwind";

// trapped: a call into the runtime threw, so the runtime can't be called
// again.
export class StartupFailed extends Data.TaggedError("StartupFailed")<{
  readonly message: string;
  readonly trapped?: boolean;
}> {}

// A call into the runtime threw: a trap, an abort, or Emscripten unwinding
// the host for another thread's crash.
export class RuntimeStopped extends Data.TaggedError("RuntimeStopped")<{ readonly error: unknown }> {}

export class RelayFailed extends Data.TaggedError("RelayFailed")<{ readonly message: string }> {}

// In a browser, a thread's uncaught error reaches this thread as the
// ErrorEvent its Worker fired, which Emscripten rethrows.
export const describe = (error: unknown): string => {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  if (typeof ErrorEvent === "function" && error instanceof ErrorEvent)
    return `${error.message} (${error.filename}:${error.lineno})`;
  return String(error);
};

// The promise's value, or fallback if it takes longer than ms.
const within = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

// A failure outside the runtime: importing or instantiating it, the locks,
// the probe.
const startupFailed = (error: unknown): StartupFailed => new StartupFailed({ message: describe(error) });

// A failure in a block that calls into the runtime. Only a failure the host
// raised itself, an error the runtime returned or a refusal before a call,
// leaves the runtime fit to call; whatever else was thrown, a trap, an
// abort, a WebAssembly exception, a stack overflow, an error in Emscripten's
// glue, an exit or an unwind, may have come from inside it.
export const runtimeCallFailed = (error: unknown): StartupFailed =>
  new StartupFailed({ message: describe(error), trapped: !(error instanceof RuntimeRefused) });

// What a Worker's error event carries, as far as the host reads it.
export interface UncaughtError {
  error?: unknown;
  message?: string;
  preventDefault(): void;
}

// What the host needs of the Worker it runs in.
export interface WorkerEnv {
  post(message: HostMessage): void;
  // Calls listener with each uncaught error this thread's event loop
  // delivers.
  onUncaughtError(listener: (event: UncaughtError) => void): void;
  // The relay's script.
  relayUrl: URL;
}

// The Worker scope: the control buffer, and the host's channel to the page.
export interface HostWorkerShape {
  readonly init: HostInit<WebAssembly.Module, unknown>;
  readonly control: ControlViews;
  readonly env: WorkerEnv;
  // Posts "ready"; from here on, a failure is a crash, not a failed start.
  readonly ready: () => void;
  // Writes CRASHED to the control buffer at once, so the page stops
  // waiting, and starts keeping the next uncaught error as the cause.
  readonly crashed: () => void;
}

export class HostWorker extends Context.Service<HostWorker, HostWorkerShape>()("@ibus-web/worker-host/HostWorker") {}

// Log records go to the page as "log" messages.
const hostLogger = (post: WorkerEnv["post"]): Logger.Logger<unknown, void> =>
  Logger.make(({ logLevel, message, cause }) => {
    const parts = Array.isArray(message) ? message : [message];
    const text = parts.map((part) => (typeof part === "string" ? part : describe(part))).join(" ");
    post({
      type: "log",
      level: logLevel,
      message: cause.reasons.length === 0 ? text : `${text}\n${Cause.pretty(cause)}`,
    });
  });

// Why the host stopped, for its crash report.
const crashMessage = (cause: Cause.Cause<unknown>, threadError: Promise<string>, waitMs: number): Promise<string> => {
  const error = Cause.findErrorOption(cause);
  if (error._tag === "Some") {
    const failure = error.value;
    if (failure instanceof RelayFailed) return Promise.resolve(`relay: ${failure.message}`);
    if (failure instanceof RuntimeStopped) {
      if (failure.error !== UNWIND) return Promise.resolve(describe(failure.error));
      return within(threadError, waitMs, "its error never arrived").then((why) => `a thread crashed: ${why}`);
    }
  }
  return Promise.resolve(Cause.pretty(cause));
};

const startupMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.findErrorOption(cause);
  return error._tag === "Some" && error.value instanceof StartupFailed ? error.value.message : Cause.pretty(cause);
};

// Acquires the control buffer's views and, released with a failure, reports
// it: before "ready" as a failed start, after it as a crash, CRASHED written
// first.
export const workerLayer = (
  init: HostInit<WebAssembly.Module, unknown>,
  env: WorkerEnv,
): Layer.Layer<HostWorker, never, HostConfig> =>
  Layer.effect(
    HostWorker,
    Effect.gen(function* () {
      const config = yield* HostConfig;
      const startedAt = performance.now();
      const control = controlViews(init.control);
      let isReady = false;
      let isCrashed = false;
      let keepError: (why: string) => void = () => {};
      const threadError = new Promise<string>((resolve) => {
        keepError = resolve;
      });
      // Registered now rather than once the host stops: the thread's error
      // may already be queued by then.
      env.onUncaughtError((event) => {
        if (!isCrashed) return;
        event.preventDefault();
        keepError(describe(event.error ?? event.message));
      });
      const crashed = (): void => {
        isCrashed = true;
        postCrash(control);
      };
      yield* Effect.addFinalizer((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : isReady
            ? Effect.promise(async () => {
                crashed();
                env.post({ type: "crashed", message: await crashMessage(exit.cause, threadError, config.crashWaitMs) });
              })
            : Effect.sync(() => env.post({ type: "error", message: startupMessage(exit.cause) })),
      );
      return {
        init,
        control,
        env,
        ready: () => {
          isReady = true;
          env.post({ type: "ready", startupMs: performance.now() - startedAt });
        },
        crashed,
      };
    }),
  ).pipe(Layer.provideMerge(Logger.layer([hostLogger(env.post)])));

// The storage's plan: what to mount at the engine's directory, decided
// before the runtime's memory is made, since a mount in memory needs a
// larger one, and the locks, among them the engine's writer lock, which the
// host takes before it creates its user backend. Released, it lets go of
// every lock, but of the writer lock only once the user backend is sealed.
export interface PlannedStorageShape {
  readonly plan: StoragePlan;
  readonly held: Held;
  // The runtime's memory, in bytes.
  readonly memory: HostInit["memory"];
}

export class PlannedStorage extends Context.Service<PlannedStorage, PlannedStorageShape>()(
  "@ibus-web/worker-host/PlannedStorage",
) {}

export const storagePlanLayer: Layer.Layer<PlannedStorage, StartupFailed, HostWorker> = Layer.effect(
  PlannedStorage,
  Effect.gen(function* () {
    const { init } = yield* HostWorker;
    const instruments = yield* Instruments;
    const held = new Held();
    yield* Effect.addFinalizer(() => Effect.sync(() => held.releaseAll()));
    for (const name of instruments.moreLocks()) {
      const lock = yield* Effect.tryPromise({ try: () => requestLock(name, {}), catch: startupFailed });
      if (lock !== null) held.add(lock);
    }
    instruments.beforeProbe();
    const plan = yield* Effect.tryPromise({
      try: () => planStorage(init.storage, init.engine, init.constants.idbReadOnly, held),
      catch: startupFailed,
    });
    return { plan, held, memory: memoryFor(init.memory, plan, init.engine) };
  }),
);

// The runtime scope: the runtime, started in a memory the host makes at the
// engine's size, and set up to pump on this thread. Nothing to release: the
// runtime ends with the Worker.
export interface HostRuntimeShape {
  readonly handle: RuntimeHandle;
  readonly wakeIndex: number;
  // Where requests and replies sit in the runtime's memory, each the
  // control slot's size.
  readonly buffers: LoopContext["buffers"];
}

export class HostRuntime extends Context.Service<HostRuntime, HostRuntimeShape>()(
  "@ibus-web/worker-host/HostRuntime",
) {}

export const runtimeLayer: Layer.Layer<HostRuntime, StartupFailed, HostWorker | PlannedStorage> = Layer.effect(
  HostRuntime,
  Effect.gen(function* () {
    const { init, control } = yield* HostWorker;
    const { memory: bytes } = yield* PlannedStorage;
    const instruments = yield* Instruments;
    yield* Effect.try({ try: () => checkMemory(bytes, init.constants.memory), catch: startupFailed });
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

// The wake relay: the page bumps the control buffer's wake word, which the
// host, asleep in the runtime, doesn't sleep on. It bumps a word in the
// runtime's memory, so it starts once the runtime has one, and it ends with
// the runtime's scope.
export interface RelayShape {
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

// Whether the runtime may still be called once a scope closes with exit:
// not once a call into it has thrown, since after a trap its memory can't
// be trusted.
export const runtimeIntact = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isSuccess(exit) ||
  !exit.cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      (reason.error instanceof RuntimeStopped ||
        (reason.error instanceof StartupFailed && reason.error.trapped === true)),
  );

// Registers a finalizer that calls into the runtime: it runs only while the
// runtime is intact.
export const runtimeFinalizer = <R>(
  release: Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R | Scope.Scope> =>
  Effect.addFinalizer((exit) => (runtimeIntact(exit) ? release : Effect.void));

// The storage's mounts: the engine's own files at its directory. The
// backends' threads and connections end with the Worker, since WasmFS never
// destroys a backend; released while the runtime can still be called, it
// seals a read-write user backend, which lets the writer lock go.
export class Storage extends Context.Service<Storage, MountedStorage>()("@ibus-web/worker-host/Storage") {}

export const storageLayer: Layer.Layer<Storage, StartupFailed, HostWorker | HostRuntime | PlannedStorage> =
  Layer.effect(
    Storage,
    Effect.gen(function* () {
      const { init, env } = yield* HostWorker;
      const { handle } = yield* HostRuntime;
      const { plan, held } = yield* PlannedStorage;
      const instruments = yield* Instruments;
      const mounted = yield* Effect.tryPromise({
        try: () => mount(handle, plan, engineDir(init.engine)),
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
                `sealing the engine's user data failed, so this host keeps ${engineWriterLock(init.engine)} until its Worker ends: ${describe(error)}`,
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
          message: `another instance of engine ${init.engine.name} holds ${engineWriterLock(init.engine)}; this one's user data refuses changes${plan.mount === "node" ? " (in browsers; the Node backend has no read-only mode)" : ""}`,
        });
      instruments.storageMounted(mounted);
      return mounted;
    }),
  );

// The engine module scope: the side modules, loaded and registered. Side
// modules are never unloaded, and the runtime has no module shutdown call,
// so there is nothing to release.
export interface EngineModuleShape {
  readonly names: readonly string[];
}

export class EngineModule extends Context.Service<EngineModule, EngineModuleShape>()(
  "@ibus-web/worker-host/EngineModule",
) {}

export const engineModuleLayer: Layer.Layer<EngineModule, StartupFailed, HostWorker | HostRuntime> = Layer.effect(
  EngineModule,
  Effect.gen(function* () {
    const { init } = yield* HostWorker;
    const { handle } = yield* HostRuntime;
    yield* Effect.try({ try: () => loadSides(handle, init.sides), catch: runtimeCallFailed });
    return { names: init.sides.map(({ name }) => name) };
  }),
);

// Serves requests for good, leaving the synchronous section only to top the
// pool up or for an instrument's reply. Fails once the runtime or the relay
// stops.
export const serve: Effect.Effect<
  never,
  RuntimeStopped | RelayFailed,
  HostWorker | HostRuntime | Relay | Storage | HostConfig
> = Effect.gen(function* () {
  const worker = yield* HostWorker;
  const { handle, wakeIndex, buffers } = yield* HostRuntime;
  const relay = yield* Relay;
  const storage = yield* Storage;
  const config = yield* HostConfig;
  const instruments = yield* Instruments;
  const { init, control } = worker;
  // The page hears of it once.
  let closedReported = false;
  const watchStorage = (): void => {
    if (closedReported || !storage.closed()) return;
    closedReported = true;
    worker.env.post({
      type: "storage",
      state: "closed",
      message: "the IndexedDB connection closed; the engine's storage fails with EIO",
    });
  };
  const ctx: LoopContext = {
    watchStorage,
    handle,
    control,
    constants: init.constants,
    wakeIndex,
    buffers,
    instruments,
    lowWater: init.poolLowWater,
    topUpFailed: false,
    woken: false,
  };
  // Runs a runtime call; one that throws marks the host crashed before
  // anything else can happen.
  const guarded = <T>(call: () => T): Effect.Effect<T, RuntimeStopped> =>
    Effect.try({
      try: call,
      catch: (error) => {
        worker.crashed();
        return new RuntimeStopped({ error });
      },
    });
  const relayFailed = Effect.gen(function* () {
    const message = yield* Effect.promise(() => within(relay.failed, config.crashWaitMs, "stopped without an error"));
    return yield* new RelayFailed({ message });
  });
  const answer = (reply: Promise<InstrumentReply>) =>
    Effect.promise(() => reply).pipe(Effect.map(({ ret, bytes }) => postReply(control, ret, bytes)));

  // The only asynchronous excursion: the new Workers load only while this
  // thread's event loop runs, so the host waits for requests with
  // Atomics.waitAsync() meanwhile, serving and pumping as it would asleep.
  const topUpPool = (want: number) =>
    Effect.gen(function* () {
      instruments.eventLoopTurn();
      let outcome: { ms: number; createMs: number } | { error: unknown } | undefined;
      const loaded = topUp(handle.rt, want, config.topUpLimitMs).then(
        (done) => {
          outcome = done;
        },
        (error: unknown) => {
          outcome = { error };
        },
      );
      while (outcome === undefined) {
        const next = yield* guarded(() => step(ctx));
        if (next.kind === "served") continue;
        if (next.kind === "await") {
          yield* answer(next.reply);
          continue;
        }
        if (next.kind === "relayFailed") return yield* relayFailed;
        const woke = Atomics.waitAsync(
          handle.words,
          wakeIndex,
          next.seen,
          next.delay < 0 ? Infinity : next.delay,
        ).value;
        const value =
          typeof woke === "string" ? woke : yield* Effect.promise(() => Promise.race([woke, loaded.then(() => "")]));
        ctx.woken = value === "ok";
      }
      if ("error" in outcome) {
        ctx.topUpFailed = true;
        yield* Effect.logError(describe(outcome.error));
      } else instruments.toppedUp(want, outcome.ms, outcome.createMs);
    });

  for (;;) {
    const excursion = yield* guarded(() => serveUntilExcursion(ctx));
    switch (excursion.kind) {
      case "topUp":
        yield* topUpPool(excursion.want);
        break;
      case "await":
        yield* answer(excursion.reply);
        break;
      case "relayFailed":
        return yield* relayFailed;
    }
  }
});

// Every scope the host runs in, outermost last.
export const hostLayer = (
  init: HostInit<WebAssembly.Module, unknown>,
  env: WorkerEnv,
): Layer.Layer<HostWorker | PlannedStorage | HostRuntime | Relay | Storage | EngineModule, StartupFailed, HostConfig> =>
  engineModuleLayer.pipe(
    Layer.provideMerge(storageLayer),
    Layer.provideMerge(relayLayer),
    Layer.provideMerge(runtimeLayer),
    Layer.provideMerge(storagePlanLayer),
    Layer.provideMerge(workerLayer(init, env)),
  );

// The host: starts every scope, says it is ready, then serves until the
// runtime stops. Failures are reported to the page as the Worker scope
// closes, so the program itself never fails.
export const program = (
  init: HostInit<WebAssembly.Module, unknown>,
  env: WorkerEnv,
): Effect.Effect<void, never, HostConfig> =>
  Effect.gen(function* () {
    const worker = yield* HostWorker;
    worker.ready();
    return yield* serve;
  }).pipe(Effect.provide(hostLayer(init, env)), Effect.ignore);
