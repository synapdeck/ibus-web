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

import { CrashReason, encodeValue, type EngineManifest } from "@ibus-web/protocol";
import { readManifest, fetchBytes } from "./startup.ts";
import { mountStore } from "./store.ts";
import { EngineScopes } from "./scopes.ts";
import { writeHostRecord, drainOutput, HostDefect } from "./output.ts";
import { Cause, Context, Effect, Exit, Layer, Logger } from "effect";
import { engineDir, engineWriterLock } from "../shared/naming.ts";
import { RingWriter, transportLayout } from "@ibus-web/protocol/transport";
import { controlViews, postCrash, Word, type ControlViews } from "../shared/control.ts";
import { WASM_PAGE, type HostInit, type HostMessage, type RuntimeMemory } from "../shared/messages.ts";
import { HostConfig } from "./config.ts";
import {
  describe,
  RelayFailed,
  runtimeCallFailed,
  runtimeFinalizer,
  runtimeIntact,
  RuntimeStopped,
  StartupFailed,
  startupFailed,
} from "./failure.ts";
import { provideData } from "./install/provide.ts";
import { Held } from "./storage/held.ts";
import { mount, type MountedStorage } from "./storage/mount.ts";
import { memoryFor, planStorage, type StoragePlan } from "./storage/plan.ts";
import type { RelayInit } from "./forward.ts";
import { Instruments, type InstrumentReply } from "./instruments.ts";
import { finishReply, serveUntilExcursion, step, topUp, type LoopContext } from "./loop.ts";
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

// The promise's value, or fallback if it takes longer than ms.
const within = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

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
  readonly writer: RingWriter;
  readonly env: WorkerEnv;
  // Posts "ready"; from here on, a failure is a crash, not a failed start.
  readonly ready: () => void;
  // Writes the Crashed record, if the ring has room, then CRASHED, so the
  // page stops waiting and a drain once it sees CRASHED finds the record;
  // then starts keeping the next uncaught error as the cause. Only the first
  // call does anything.
  readonly crashed: (record: CrashRecord) => void;
}

// What the Crashed record says: what is known at once, which a crashed
// thread's own error isn't; the crash report carries that.
export interface CrashRecord {
  readonly reason: number;
  readonly message: string;
}

export class HostWorker extends Context.Service<HostWorker, HostWorkerShape>()("@ibus-web/worker-host/HostWorker") {}

const hostLogger = (writer: RingWriter, control: ControlViews, notify: () => void): Logger.Logger<unknown, void> =>
  Logger.make(({ logLevel, message, cause }) => {
    const parts = Array.isArray(message) ? message : [message];
    const text = parts.map((part) => (typeof part === "string" ? part : describe(part))).join(" ");
    const levels = { All: 128, Fatal: 4, Error: 8, Warn: 16, Info: 64, Debug: 128, Trace: 128, None: 0 };
    const payload = encodeValue("(uss)", {
      _tag: "()",
      items: [
        { _tag: "u", value: levels[logLevel] },
        { _tag: "s", value: "worker-host" },
        { _tag: "s", value: cause.reasons.length === 0 ? text : `${text}\n${Cause.pretty(cause)}` },
      ],
    });
    if (writeHostRecord(writer, control, 33, payload)) notify();
  });

// Cleanup failures are defects because Effect finalizers cannot fail through
// the typed channel. Their RuntimeStopped value still controls later scopes.
const crashFailure = (cause: Cause.Cause<unknown>): RuntimeStopped | RelayFailed | undefined => {
  for (const reason of cause.reasons) {
    let error: unknown;
    if (Cause.isFailReason(reason)) error = reason.error;
    else if (Cause.isDieReason(reason)) error = reason.defect;
    else continue;
    if (error instanceof RuntimeStopped || error instanceof RelayFailed) return error;
  }
  return undefined;
};

const stoppedRecord = (failure: RuntimeStopped): CrashRecord => ({
  reason: failure.reason ?? CrashReason.trap,
  message: failure.error === UNWIND ? "a thread crashed" : describe(failure.error),
});

const crashRecord = (cause: Cause.Cause<unknown>): CrashRecord => {
  const failure = crashFailure(cause);
  if (failure instanceof RelayFailed) return { reason: CrashReason.relay, message: `relay: ${failure.message}` };
  if (failure instanceof RuntimeStopped) return stoppedRecord(failure);
  return { reason: CrashReason.host, message: Cause.pretty(cause) };
};

const crashMessage = (cause: Cause.Cause<unknown>, threadError: Promise<string>, waitMs: number): Promise<string> => {
  const failure = crashFailure(cause);
  if (failure instanceof RelayFailed) return Promise.resolve(`relay: ${failure.message}`);
  if (failure instanceof RuntimeStopped) {
    if (failure.error !== UNWIND) return Promise.resolve(describe(failure.error));
    return within(threadError, waitMs, "its error never arrived").then((why) => `a thread crashed: ${why}`);
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
): Layer.Layer<HostWorker, never, HostConfig> => {
  const layout = init.layout ?? transportLayout();
  const control = controlViews(init.control, layout);
  const writer = new RingWriter(control, layout);
  const notify = (): void => {
    if (Atomics.exchange(control.words, Word.doorbell, 1) === 0) env.post({ type: "doorbell" });
  };
  return Layer.effect(
    HostWorker,
    Effect.gen(function* () {
      const config = yield* HostConfig;
      const startedAt = performance.now();
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
      const crashed = ({ reason, message }: CrashRecord): void => {
        if (isCrashed) return;
        isCrashed = true;
        writeHostRecord(
          writer,
          control,
          34,
          encodeValue("(us)", {
            _tag: "()",
            items: [
              { _tag: "u", value: reason },
              { _tag: "s", value: message },
            ],
          }),
        );
        postCrash(control);
      };
      yield* Effect.addFinalizer((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : isReady
            ? Effect.promise(async () => {
                crashed(crashRecord(exit.cause));
                const message = await crashMessage(exit.cause, threadError, config.crashWaitMs);
                env.post({ type: "crashed", message });
              })
            : Effect.sync(() => env.post({ type: "error", message: startupMessage(exit.cause) })),
      );
      return {
        init,
        control,
        writer,
        env,
        ready: () => {
          isReady = true;
          env.post({ type: "ready", startupMs: performance.now() - startedAt });
        },
        crashed,
      };
    }),
  ).pipe(Layer.provideMerge(Logger.layer([hostLogger(writer, control, notify)])));
};

// The storage's plan: what to mount at the engine's directory, decided
// before the runtime's memory is made, since a mount in memory needs a
// larger one, and the locks, among them the engine's writer lock, which the
// host takes before it creates its user backend. Released, it lets go of
// every lock, but of the writer lock only once the user backend is sealed.
export interface PlannedStorageShape {
  readonly plan: StoragePlan;
  readonly held: Held;
  // The runtime's memory, in bytes.
  readonly memory: RuntimeMemory;
  readonly manifest: EngineManifest;
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
    const manifest = yield* Effect.tryPromise({
      try: () => readManifest(init),
      catch: (error) => (error instanceof StartupFailed ? error : startupFailed(error)),
    });
    const held = new Held();
    yield* Effect.addFinalizer(() => Effect.sync(() => held.releaseAll()));
    instruments.beforeProbe();
    const plan = yield* Effect.tryPromise({
      try: () => planStorage(init.storage, manifest, init.constants.idbReadOnly, held),
      catch: startupFailed,
    });
    const module = yield* Effect.tryPromise({ try: () => fetchBytes(manifest.module.url), catch: startupFailed });
    if (module.length !== manifest.module.size)
      return yield* new StartupFailed({ message: `module size ${module.length}, expected ${manifest.module.size}` });
    return {
      plan,
      held,
      manifest,
      module: module.buffer as ArrayBuffer,
      memory: memoryFor({ initial: manifest.memory, maximum: manifest.memory }, plan, manifest),
    };
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
    const { memory: bytes, manifest } = yield* PlannedStorage;
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
            ibuswebEngineThreads: manifest.threads,
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

// The storage's mounts: the engine's own files at its directory, and its
// data, installed first if need be, at /nix/store. The
// backends' threads and connections end with the Worker, since WasmFS never
// destroys a backend; released while the runtime can still be called, it
// seals the read-write backends, which lets the writer lock go.
export class Storage extends Context.Service<Storage, MountedStorage>()("@ibus-web/worker-host/Storage") {}

export const storageLayer: Layer.Layer<Storage, StartupFailed, HostWorker | HostRuntime | PlannedStorage | HostConfig> =
  Layer.effect(
    Storage,
    Effect.gen(function* () {
      const { init, env } = yield* HostWorker;
      const { handle } = yield* HostRuntime;
      const { plan, held, manifest } = yield* PlannedStorage;
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
                `sealing the engine's user data failed, so this host keeps ${engineWriterLock(manifest)} until its Worker ends: ${describe(error)}`,
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
        idbReadOnly: init.constants.idbReadOnly,
        held,
        config,
        instruments,
        post: env.post,
      });
      const storage: MountedStorage = { ...mounted, closed: () => mounted.closed() || data.closed() };
      yield* Effect.try({ try: () => mountStore(handle, manifest), catch: runtimeCallFailed });
      yield* Effect.try({ try: () => instruments.storageMounted(storage), catch: runtimeCallFailed });
      return storage;
    }),
  );

// Serves requests for good, leaving the synchronous section only to top the
// pool up or for an instrument's reply. Fails once the runtime or the relay
// stops.
export const serve: Effect.Effect<
  void,
  RuntimeStopped | RelayFailed,
  HostWorker | HostRuntime | Relay | Storage | HostConfig | PlannedStorage
> = Effect.gen(function* () {
  const worker = yield* HostWorker;
  const { handle, wakeIndex, buffers } = yield* HostRuntime;
  const relay = yield* Relay;
  const storage = yield* Storage;
  const config = yield* HostConfig;
  const instruments = yield* Instruments;
  const { init, control } = worker;
  const { module } = yield* PlannedStorage;
  // Runs a runtime call; one that throws marks the host crashed before
  // anything else can happen.
  const guarded = <T>(call: () => T): Effect.Effect<T, RuntimeStopped> =>
    Effect.try({
      try: call,
      catch: (error) => {
        const stopped =
          error instanceof RuntimeStopped
            ? error
            : new RuntimeStopped({ error, reason: error instanceof HostDefect ? CrashReason.host : CrashReason.trap });
        worker.crashed(stoppedRecord(stopped));
        return stopped;
      },
    });
  const scopes = new EngineScopes(buffers.request, init.constants.canceled);
  let moduleLoaded = false;
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
  const outputLength = yield* guarded(() => new Int32Array(handle.bytes.buffer, alloc(handle, 4), 1));
  const ctx: LoopContext = {
    watchStorage,
    handle,
    control,
    constants: init.constants,
    wakeIndex,
    buffers,
    instruments,
    lowWater: init.poolLowWater,
    writer: worker.writer,
    scopes,
    loadEngine: () => {
      if (moduleLoaded) return;
      try {
        loadSides(handle, [{ name: "engine", bytes: module }]);
      } catch (error) {
        // A refused load leaves the runtime fit to call, so its account of
        // the failure reaches the page ahead of the Crashed record.
        if (error instanceof RuntimeRefused)
          try {
            drainOutput(handle.rt, worker.writer, outputLength, ctx);
          } catch {
            // The crash is already LOAD's; a failed drain only loses records.
          }
        throw new RuntimeStopped({ error, reason: CrashReason.load });
      }
      moduleLoaded = true;
    },
    outputLength,
    postDoorbell: () => worker.env.post({ type: "doorbell" }),
    lastSeq: 0,
    topUpFailed: false,
    stopping: false,
    woken: false,
  };
  yield* Effect.addFinalizer((exit) =>
    guarded(() => {
      const intact = runtimeIntact(exit);
      scopes.closeAll(handle.rt, intact);
      if (intact) drainOutput(handle.rt, worker.writer, outputLength, ctx);
    }).pipe(Effect.orDie),
  );
  const relayFailed = Effect.gen(function* () {
    const message = yield* Effect.promise(() => within(relay.failed, config.crashWaitMs, "stopped without an error"));
    return yield* new RelayFailed({ message });
  });
  const answer = (reply: Promise<InstrumentReply>) =>
    Effect.promise(() => reply).pipe(Effect.flatMap((value) => guarded(() => finishReply(ctx, value))));

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
        if (next.kind === "stopped") return;
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
      case "stopped":
        return;
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
}).pipe(Effect.scoped);

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
