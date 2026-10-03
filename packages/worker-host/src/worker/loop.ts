// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The request loop: plain functions, run as one synchronous section. A thread
// asleep in ibusweb_wait() runs nothing else, so nothing here may rely on
// another fiber, a timer or a promise; GLib's time is the wait's timeout.

import { postReply, requestBytes, State, Word, type ControlViews } from "../shared/control.ts";
import type { RuntimeConstants } from "../shared/messages.ts";
import type { InstrumentReply, Instruments } from "./instruments.ts";
import type { Runtime, RuntimeHandle } from "./runtime.ts";

export interface LoopContext {
  // Reports storage that has failed since the host last woke.
  readonly watchStorage: () => void;
  readonly handle: RuntimeHandle;
  readonly control: ControlViews;
  readonly constants: RuntimeConstants;
  // The index of the wake word the host sleeps on in the runtime's memory.
  readonly wakeIndex: number;
  // Where requests and replies sit in the runtime's memory, each the
  // control slot's size.
  readonly buffers: { readonly request: number; readonly reply: number; readonly cap: number };
  readonly instruments: Instruments;
  readonly lowWater: number;
  // Set once a top-up has failed; another would most likely fail the same
  // way.
  topUpFailed: boolean;
  // Whether the last wait ended with its word changed, which is how a
  // request that arrives while the host sleeps wakes it.
  woken: boolean;
}

// One turn of the loop:
//  - "served": a request was answered.
//  - "await": an instrument answers the request once the promise settles.
//  - "relayFailed": the control buffer says CRASHED, which only the relay
//    writes while the host runs.
//  - "idle": nothing is pending; seen is the wake word as read before
//    looking, and delay the pump's.
export type Step =
  | { kind: "served" }
  | { kind: "await"; reply: Promise<InstrumentReply> }
  | { kind: "relayFailed" }
  | { kind: "idle"; seen: number; delay: number };

// Why the synchronous section returned.
export type Excursion =
  | { kind: "topUp"; want: number }
  | { kind: "await"; reply: Promise<InstrumentReply> }
  | { kind: "relayFailed" };

export const pump = (rt: Runtime, constants: RuntimeConstants): number => {
  const delay = rt._ibusweb_pump();
  if (delay === constants.pumpError) throw new Error("pumped off the runtime's thread");
  return delay;
};

// Answers the request in the slot, unless an instrument answers it later.
const serveRequest = (ctx: LoopContext): Promise<InstrumentReply> | undefined => {
  const { control, handle, buffers } = ctx;
  const request = requestBytes(control);
  ctx.instruments.requestServed(ctx.woken);
  ctx.woken = false;
  const own = ctx.instruments.serve(request);
  if (own instanceof Promise) return own;
  if (own !== undefined) {
    postReply(control, own.ret, own.bytes);
    return undefined;
  }
  handle.bytes.set(request, buffers.request);
  const ret = handle.rt._ibusweb_dispatch(buffers.request, request.length, buffers.reply, buffers.cap);
  pump(handle.rt, ctx.constants);
  postReply(control, ret, ret > 0 ? handle.bytes.subarray(buffers.reply, buffers.reply + ret) : undefined);
  return undefined;
};

// The wake word is read before the state and the pump look, so a wake that
// lands after them changes it and the sleep on it returns at once.
export const step = (ctx: LoopContext): Step => {
  const { control, handle } = ctx;
  ctx.watchStorage();
  const seen = Atomics.load(handle.words, ctx.wakeIndex);
  const state = Atomics.load(control.words, Word.state);
  if (state === State.crashed) return { kind: "relayFailed" };
  if (state === State.request) {
    const reply = serveRequest(ctx);
    return reply === undefined ? { kind: "served" } : { kind: "await", reply };
  }
  ctx.woken = false;
  const delay = pump(handle.rt, ctx.constants);
  const after = Atomics.load(control.words, Word.state);
  if (after === State.request || after === State.crashed) return { kind: "served" };
  return { kind: "idle", seen, delay };
};

// Serves requests and pumps, sleeping in ibusweb_wait() between them, until
// the pool needs topping up while no request is pending, or something must
// wait for the event loop. A runtime call that traps throws out of here.
export const serveUntilExcursion = (ctx: LoopContext): Excursion => {
  const { handle, instruments } = ctx;
  for (;;) {
    const next = step(ctx);
    if (next.kind === "served") continue;
    if (next.kind !== "idle") return next;
    const idle = handle.rt.PThread.unusedWorkers.length;
    if (!ctx.topUpFailed && !instruments.topUpsHeld() && idle < ctx.lowWater)
      return { kind: "topUp", want: ctx.lowWater - idle };
    // ibusweb_wait() can't tell a word that changed before it slept from one
    // that changed during, so the word is read once more just before the
    // call: a change before that read doesn't count as waking the host. One
    // that lands between that read and the futex wait inside the call, a
    // window of a few instructions, still does.
    const unmoved = Atomics.load(handle.words, ctx.wakeIndex) === next.seen;
    const ret = handle.rt._ibusweb_wait(next.seen, next.delay);
    if (ret < 0 && ret !== ctx.constants.waitTimedOut) throw new Error(`ibusweb_wait: ${ret}`);
    ctx.woken = unmoved && ret === 0;
  }
};

// pthread_create() fails with EAGAIN rather than wait for a Worker beyond
// the pool: a browser starts a new Worker, or in Firefox even creates one,
// only while the thread creating it is back in its event loop, which a host
// that sleeps in the runtime isn't. So the host adds Workers while it is in
// its event loop, and keeps each out of the pool until it has loaded, since
// pthread_create() hands out any Worker in the pool, and a thread on one
// that hasn't started yet wouldn't start while the host then blocks.
// Rejects if the Workers haven't all loaded within limitMs; any that load
// later still join the pool.
export const topUp = (rt: Runtime, want: number, limitMs: number): Promise<{ ms: number; createMs: number }> => {
  const { PThread } = rt;
  const startedAt = performance.now();
  const loading: Promise<void>[] = [];
  for (let i = 0; i < want; i++) {
    const worker = PThread.allocateUnusedWorker();
    const index = PThread.unusedWorkers.indexOf(worker);
    if (index < 0)
      return Promise.reject(new Error("PThread.allocateUnusedWorker() didn't add its Worker to PThread.unusedWorkers"));
    PThread.unusedWorkers.splice(index, 1);
    loading.push(
      PThread.loadWasmModuleToWorker(worker).then(() => {
        PThread.unusedWorkers.push(worker);
      }),
    );
  }
  const createMs = performance.now() - startedAt;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`pool top-up: ${want} Workers not all loaded in ${limitMs} ms`)),
      limitMs,
    );
  });
  return Promise.race([Promise.all(loading), late])
    .then(() => ({ ms: performance.now() - startedAt, createMs }))
    .finally(() => clearTimeout(timer));
};
