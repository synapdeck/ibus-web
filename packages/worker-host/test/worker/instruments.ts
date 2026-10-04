// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The test build's instruments: counters behind HostOp.stats, and the other
// HostOp requests.

import type { HostConfigValues } from "../../src/shared/config.ts";

import type { InstrumentReply, Instruments } from "../../src/worker/instruments.ts";
import { topUp } from "../../src/worker/loop.ts";
import { loadSides, type RuntimeHandle } from "../../src/worker/runtime.ts";
import type { MountedStorage } from "../../src/worker/storage/mount.ts";
import {
  PumpControl,
  RuntimeCall,
  HostOp,
  type HostStats,
  type TestInit,
  type TestMessage,
} from "../shared/testing.ts";

// Counts the Workers Emscripten creates, through the global Worker class.
// Under Node, Emscripten first assigns worker_threads' Worker to the global,
// so the global becomes an accessor that wraps whichever class it is given.
const workerCounts = () => ({ created: 0, counting: false, live: 0, peak: 0 });
const trackWorkers = (): ReturnType<typeof workerCounts> => {
  const workers = workerCounts();
  const wrap = (Base: typeof Worker): typeof Worker =>
    class extends Base {
      private terminated = false;
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        if (workers.counting) workers.created++;
        workers.live++;
        workers.peak = Math.max(workers.peak, workers.live);
      }
      override terminate(): void {
        if (!this.terminated) {
          this.terminated = true;
          workers.live--;
        }
        super.terminate();
      }
    };
  let current = wrap(globalThis.Worker);
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    get: () => current,
    set: (Base: typeof Worker) => {
      current = wrap(Base);
    },
  });
  return workers;
};

// As an opaque origin's indexedDB.open() does, in the host's realm only.
const withholdIndexedDB = (): void => {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open: () => {
        throw new DOMException("IndexedDB is withheld from this host", "SecurityError");
      },
    },
  });
};

// Long enough that the loop reaches the messages already queued for it, not
// only the timer.
const yieldToEventLoop = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const encoder = new TextEncoder();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const makeInstruments = (
  test: TestInit,
  config: HostConfigValues,
  post: (message: TestMessage) => void,
): Instruments => {
  let workers = workerCounts();
  let runtime: RuntimeHandle | undefined;
  let storage: MountedStorage = { mount: "none", closed: () => false };
  let scratch = 0;
  let requestBuffer = 0;
  let replyBuffer = 0;
  const capacity = 64 * 1024;
  let held = false;
  const loadedModules: string[] = [];
  const counters = {
    activeThreadsAtRuntimeStart: 0,
    activeThreadsPeak: 0,
    requests: 0,
    requestsWhileAsleep: 0,
    topUps: 0,
    topUpWorkers: 0,
    lastTopUpMs: null as number | null,
    lastTopUpCreateMs: null as number | null,
    eventLoopTurns: 0,
  };
  const toppedUp = (want: number, ms: number, createMs: number): void => {
    counters.topUps++;
    counters.topUpWorkers += want;
    counters.lastTopUpMs = ms;
    counters.lastTopUpCreateMs = createMs;
  };
  const stats = ({ rt, words, memory }: RuntimeHandle): HostStats => {
    // mallinfo() is in the runtime's exports, though not in what the host
    // uses of it.
    (rt as unknown as { _mallinfo(out: number): void })._mallinfo(scratch);
    return {
      workersCreated: workers.created,
      poolWorkersPeak: workers.peak,
      // Emscripten dlmalloc defines MORECORE_CANNOT_TRIM: frees never lower
      // the break, so sbrk(0) retains the peak across startup and requests.
      heapPeak: (rt as unknown as { _sbrk(increment: number): number })._sbrk(0),
      idleWorkers: rt.PThread.unusedWorkers.length,
      heapInUse: words[(scratch + test.mallinfo.inUseOffset) / 4]!,
      memoryBytes: memory.buffer.byteLength,
      mount: storage.mount,
      storageClosed: storage.closed(),
      ...counters,
    };
  };
  return {
    forceBrotliFallback: test.forceBrotliFallback === true,
    beforeProbe: () => {
      if (test.withoutIndexedDB === true) withholdIndexedDB();
    },
    storageMounted: (mounted) => {
      storage = mounted;
      if (runtime !== undefined) loadSides(runtime, test.sides ?? []);
    },
    seal: (seal) => {
      if (test.sealThrows === true) throw new Error("the seal fails on purpose");
      seal();
    },
    waiting: (lock) => {
      if (test.traceInstallProgress === true) post({ type: "install-progress", event: "waiting", at: Date.now() });
      post({ type: "waiting", lock });
    },
    beforePiece: (fed) => {
      if (test.traceInstallProgress === true) post({ type: "install-progress", event: "piece", at: Date.now(), fed });
      if (fed === 0 && test.firstPieceGate !== undefined) {
        const gate = new Int32Array(test.firstPieceGate);
        return (async () => {
          while (Atomics.load(gate, 0) === 0) await sleep(5);
        })();
      }
      if (test.stallAt !== undefined && fed >= test.stallAt) {
        post({ type: "stalled", bytes: fed });
        return new Promise<void>(() => {});
      }
      return test.pieceDelayMs === undefined ? undefined : sleep(test.pieceDelayMs);
    },
    beforeRuntime: () => {
      if (test.traceInstallProgress === true || test.silentInstallProgress === true) {
        const Base = globalThis.BroadcastChannel;
        globalThis.BroadcastChannel = class extends Base {
          constructor(name: string) {
            super(name);
            if (test.traceInstallProgress === true)
              this.addEventListener("message", () =>
                post({ type: "install-progress", event: "heard", at: Date.now() }),
              );
          }
          override postMessage(message: unknown): void {
            if (test.silentInstallProgress === true) return;
            if (test.traceInstallProgress === true) post({ type: "install-progress", event: "said", at: Date.now() });
            super.postMessage(message);
          }
        };
      }
      workers = trackWorkers();
    },
    runtimeStarted: (handle) => {
      runtime = handle;
      const pool = handle.rt.PThread as typeof handle.rt.PThread & {
        pthreads: Record<string, Worker>;
        getNewWorker(): Worker | undefined;
        returnWorkerToPool(worker: Worker): void;
      };
      const active = new Set(Object.values(pool.pthreads));
      counters.activeThreadsAtRuntimeStart = active.size;
      counters.activeThreadsPeak = active.size;
      const getWorker = pool.getNewWorker.bind(pool);
      const returnWorker = pool.returnWorkerToPool.bind(pool);
      pool.getNewWorker = () => {
        const worker = getWorker();
        if (worker !== undefined) {
          active.add(worker);
          counters.activeThreadsPeak = Math.max(counters.activeThreadsPeak, active.size);
        }
        return worker;
      };
      pool.returnWorkerToPool = (worker) => {
        active.delete(worker);
        returnWorker(worker);
      };
      const counts = test.runtimeCalls === undefined ? undefined : new Int32Array(test.runtimeCalls);
      const trap = test.waitTrap === undefined ? undefined : new Int32Array(test.waitTrap);
      const defer = test.deferPump === undefined ? undefined : new Int32Array(test.deferPump);
      const pump = handle.rt._ibusweb_pump.bind(handle.rt);
      handle.rt._ibusweb_pump = () => {
        if (defer !== undefined) {
          // Keep the idle source pending until the next request dispatch, so
          // its output and the dispatch's output reach one synchronous drain.
          const command = Atomics.load(defer, 0);
          if (command === PumpControl.armHold) {
            Atomics.store(defer, 0, PumpControl.holdUntilDispatch);
            return 0;
          }
          if (command === PumpControl.holdUntilDispatch) return 0;
          if (command === PumpControl.deferOnce) {
            Atomics.store(defer, 0, PumpControl.run);
            return 0;
          }
        }
        if (counts !== undefined) Atomics.add(counts, RuntimeCall.pump, 1);
        return pump();
      };
      const dispatch = handle.rt._ibusweb_dispatch.bind(handle.rt);
      handle.rt._ibusweb_dispatch = (pointer, length) => {
        if (defer !== undefined) Atomics.compareExchange(defer, 0, PumpControl.holdUntilDispatch, PumpControl.run);
        if (counts !== undefined) Atomics.add(counts, RuntimeCall.dispatch, 1);
        return dispatch(pointer, length);
      };
      const wait = handle.rt._ibusweb_wait.bind(handle.rt);
      handle.rt._ibusweb_wait = (seen, delay) => {
        if (counts !== undefined) Atomics.add(counts, RuntimeCall.wait, 1);
        if (trap !== undefined && Atomics.exchange(trap, 0, 0) === 1) {
          if (test.waitTrapOp === undefined) throw new Error("wait trap opcode is required");
          new DataView(handle.bytes.buffer, requestBuffer, 4).setUint32(0, test.waitTrapOp, true);
          const rt = handle.rt as typeof handle.rt & {
            _ibusweb_test_dispatch(request: number, length: number, reply: number, capacity: number): number;
          };
          rt._ibusweb_test_dispatch(requestBuffer, 4, replyBuffer, capacity);
        }
        return wait(seen, delay);
      };
      const consume = handle.rt._ibusweb_output_consume.bind(handle.rt);
      handle.rt._ibusweb_output_consume = (length) => {
        if (counts !== undefined) Atomics.add(counts, RuntimeCall.consumed, length);
        return consume(length);
      };
      const load = handle.rt._ibusweb_load_module.bind(handle.rt);
      handle.rt._ibusweb_load_module = (path, out) => {
        const result = load(path, out);
        if (result === 0) {
          const end = handle.bytes.indexOf(0, path);
          loadedModules.push(new TextDecoder().decode(handle.bytes.slice(path, end)));
        }
        return result;
      };
      if (test.callsAfterFault !== undefined) {
        const counts = new Int32Array(test.callsAfterFault);
        let faulted = false;
        for (const [name, value] of Object.entries(handle.rt)) {
          if (!name.startsWith("_") || typeof value !== "function") continue;
          const rt = handle.rt as unknown as Record<string, unknown>;
          rt[name] = (...args: unknown[]) => {
            if (faulted && !name.startsWith("_ibusweb_output_")) Atomics.add(counts, 0, 1);
            const result: unknown = value.apply(handle.rt, args);
            if (name === "_ibusweb_dispatch" && result === test.canceled) faulted = true;
            return result;
          };
        }
      }
      workers.counting = true;
      scratch = handle.rt._malloc(test.mallinfo.bytes);
      requestBuffer = handle.rt._malloc(capacity);
      replyBuffer = handle.rt._malloc(capacity);
    },
    serve: (request): InstrumentReply | Promise<InstrumentReply> | undefined => {
      if (request.length < 8 || runtime === undefined) return undefined;
      const kind = new DataView(request.buffer, request.byteOffset).getUint16(0, true);
      if (kind < 0xff00) return undefined;
      const arg = (fallback: number): number =>
        request.length >= 12 ? new DataView(request.buffer, request.byteOffset + 8).getInt32(0, true) : fallback;
      switch (kind) {
        case HostOp.stop:
          return { ret: 0, stop: true };
        case HostOp.loadedModules: {
          const json = encoder.encode(JSON.stringify(loadedModules));
          return { ret: json.length, bytes: json };
        }
        case HostOp.stats: {
          const json = encoder.encode(JSON.stringify(stats(runtime)));
          return { ret: json.length, bytes: json };
        }
        case HostOp.yield:
          counters.eventLoopTurns++;
          return yieldToEventLoop(arg(10)).then(() => ({ ret: 0 }));
        case HostOp.topUp:
          held = arg(1) === 0;
          return { ret: 0 };
        case HostOp.addWorkers: {
          counters.eventLoopTurns++;
          const want = arg(1);
          return topUp(runtime.rt, want, config.topUpLimitMs).then(
            ({ ms, createMs }) => {
              toppedUp(want, ms, createMs);
              return { ret: 0 };
            },
            () => ({ ret: -1 }),
          );
        }
        default: {
          const bytes = new Uint8Array(4 + request.length - 8);
          new DataView(bytes.buffer).setUint32(0, kind, true);
          bytes.set(request.subarray(8), 4);
          runtime.bytes.set(bytes, requestBuffer);
          const rt = runtime.rt as typeof runtime.rt & {
            _ibusweb_test_dispatch(request: number, length: number, reply: number, capacity: number): number;
          };
          const ret = rt._ibusweb_test_dispatch(requestBuffer, bytes.length, replyBuffer, capacity);
          return ret > 0 ? { ret, bytes: runtime.bytes.slice(replyBuffer, replyBuffer + ret) } : { ret };
        }
      }
    },
    requestServed: (whileAsleep) => {
      counters.requests++;
      if (whileAsleep) counters.requestsWhileAsleep++;
    },
    eventLoopTurn: () => {
      counters.eventLoopTurns++;
    },
    topUpsHeld: () => held,
    toppedUp,
  };
};
