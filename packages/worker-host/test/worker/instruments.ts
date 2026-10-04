// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The test build's instruments: counters behind HostOp.stats, and the other
// HostOp requests.

import type { HostConfigValues } from "../../src/shared/config.ts";

import type { InstrumentReply, Instruments } from "../../src/worker/instruments.ts";
import { topUp } from "../../src/worker/loop.ts";
import type { RuntimeHandle } from "../../src/worker/runtime.ts";
import type { MountedStorage } from "../../src/worker/storage/mount.ts";
import { HostOp, type HostStats, type TestInit, type TestMessage } from "../shared/testing.ts";

// Counts the Workers Emscripten creates, through the global Worker class.
// Under Node, Emscripten first assigns worker_threads' Worker to the global,
// so the global becomes an accessor that wraps whichever class it is given.
const trackWorkers = (): { created: number; counting: boolean } => {
  const workers = { created: 0, counting: false };
  const wrap = (Base: typeof Worker): typeof Worker =>
    class extends Base {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        if (workers.counting) workers.created++;
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
  let workers = { created: 0, counting: false };
  let runtime: RuntimeHandle | undefined;
  let storage: MountedStorage = { mount: "none", closed: () => false };
  let scratch = 0;
  let requestBuffer = 0;
  let replyBuffer = 0;
  const capacity = 64 * 1024;
  let held = false;
  const counters = {
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
    },
    seal: (seal) => {
      if (test.sealThrows === true) throw new Error("the seal fails on purpose");
      seal();
    },
    waiting: (lock) => post({ type: "waiting", lock }),
    beforePiece: (fed) => {
      if (test.stallAt !== undefined && fed >= test.stallAt) {
        post({ type: "stalled", bytes: fed });
        return new Promise<void>(() => {});
      }
      return test.pieceDelayMs === undefined ? undefined : sleep(test.pieceDelayMs);
    },
    beforeRuntime: () => {
      workers = trackWorkers();
    },
    runtimeStarted: (handle) => {
      runtime = handle;
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
