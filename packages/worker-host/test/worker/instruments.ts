// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The test build's instruments: counters behind HostOp.stats, and the other
// HostOp requests.

import type { HostConfigValues } from "../../src/shared/config.ts";
import { requestOpcode } from "../../src/shared/control.ts";
import type { InstrumentReply, Instruments } from "../../src/worker/instruments.ts";
import { topUp } from "../../src/worker/loop.ts";
import type { RuntimeHandle } from "../../src/worker/runtime.ts";
import { HostOp, type HostStats, type TestInit } from "../shared/testing.ts";

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

// Long enough that the loop reaches the messages already queued for it, not
// only the timer.
const yieldToEventLoop = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const encoder = new TextEncoder();

export const makeInstruments = (test: TestInit, config: HostConfigValues): Instruments => {
  let workers = { created: 0, counting: false };
  let runtime: RuntimeHandle | undefined;
  let scratch = 0;
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
      ...counters,
    };
  };
  return {
    beforeRuntime: () => {
      workers = trackWorkers();
    },
    runtimeStarted: (handle) => {
      runtime = handle;
      workers.counting = true;
      scratch = handle.rt._malloc(test.mallinfo.bytes);
    },
    serve: (request): InstrumentReply | Promise<InstrumentReply> | undefined => {
      if (request.length < 4 || runtime === undefined) return undefined;
      const arg = (fallback: number): number =>
        request.length >= 8 ? new DataView(request.buffer, request.byteOffset + 4).getInt32(0, true) : fallback;
      switch (requestOpcode(request)) {
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
        default:
          return undefined;
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
