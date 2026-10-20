// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The request loop: plain functions, run as one synchronous section. A thread
// asleep in the backend's wait runs nothing else, so nothing here may rely on
// another fiber, a timer or a promise; the pump's delay is the wait's
// timeout.

import { postReply, type ControlViews } from "../shared/control.ts";
import { ReqMode, State, Word } from "@ibus-web/protocol/transport";
import { CrashReason, errorReport } from "@ibus-web/protocol";
import type { Backend, Pool } from "./backend.ts";
import { RuntimeStopped } from "./failure.ts";
import type { InstrumentReply, Instruments } from "./instruments.ts";
import type { OutputRing } from "./output.ts";
import type { Runtime } from "./runtime.ts";

export interface LoopContext {
  // Reports storage that has failed since the host last woke.
  readonly watchStorage: () => void;
  readonly backend: Backend;
  readonly control: ControlViews;
  readonly instruments: Instruments;
  // Its lastSeq is the sequence number of the last module record published
  // to the ring, which a reply names.
  readonly ring: OutputRing;
  // Set once a top-up has failed; another would most likely fail the same
  // way.
  topUpFailed: boolean;
  stopping: boolean;
  // Whether the last wait ended with its word changed, which is how a
  // request that arrives while the host sleeps wakes it.
  woken: boolean;
  // The page's messages after HostInit the host has taken, as the control
  // buffer's mail word counts them.
  mailTaken: number;
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
  | { kind: "stopped" }
  | { kind: "idle"; seen: number; delay: number };

// Why the synchronous section returned.
type Excursion =
  | { kind: "topUp"; pool: Pool; want: number }
  // The page has posted messages the host hasn't taken.
  | { kind: "mail" }
  | { kind: "await"; reply: Promise<InstrumentReply> }
  | { kind: "relayFailed" }
  | { kind: "stopped" };

export const ringDoorbell = (ctx: LoopContext): void => {
  if (Atomics.exchange(ctx.control.words, Word.doorbell, 1) === 0) ctx.ring.postDoorbell();
};

// A module's fault, during a request or outside one, ends the host once
// the output before it is in the ring.
const stopIfFaulted = (ctx: LoopContext): void => {
  const fault = ctx.backend.fault();
  if (fault !== undefined) throw new RuntimeStopped({ error: fault, reason: CrashReason.fault });
};

// Called only once the request's records are in the ring, so a reply never
// lands ahead of them.
const publishReply = (ctx: LoopContext, ret: number): void => {
  if (!postReply(ctx.control, ret, ctx.ring.lastSeq)) return;
  const mode = Atomics.load(ctx.control.words, Word.reqMode);
  if (mode !== ReqMode.sync) ringDoorbell(ctx);
  ctx.instruments.replied(mode);
};

// Both dispatch paths finish through the same publication and notification rules.
export const finishReply = (ctx: LoopContext, reply: InstrumentReply): void => {
  if (reply.stop === true) ctx.stopping = true;
  if (reply.bytes !== undefined) ctx.control.slot.set(reply.bytes);
  ctx.backend.pump();
  ctx.backend.drain();
  publishReply(ctx, reply.ret);
  stopIfFaulted(ctx);
};

const serveRequest = (ctx: LoopContext): Promise<InstrumentReply> | undefined => {
  const { control, backend } = ctx;
  const length = Atomics.load(control.words, Word.reqLen);
  if (length < 0 || length > control.slot.length) throw new Error("invalid request length");
  const request = control.slot.slice(0, length);
  ctx.instruments.requestServed(ctx.woken);
  ctx.woken = false;
  const own = ctx.instruments.serve(request);
  if (own instanceof Promise) return own;
  if (own !== undefined) {
    finishReply(ctx, own);
    return undefined;
  }

  const { ret, fault } = backend.dispatch(request);
  // Output still drains after a fault; pumping doesn't. The crash that
  // follows writes its Crashed record behind the reply.
  if (fault !== undefined) {
    let message = fault;
    try {
      backend.drain();
    } catch (error) {
      message += `; output drain failed: ${errorReport(error)}`;
    }
    publishReply(ctx, ret);
    throw new RuntimeStopped({ error: message, reason: CrashReason.fault });
  }
  finishReply(ctx, { ret });
  return undefined;
};

// The wake word is read before the state and the pump look, so a wake that
// lands after them changes it and the sleep on it returns at once.
export const step = (ctx: LoopContext): Step => {
  const { control, backend } = ctx;
  if (ctx.stopping) return { kind: "stopped" };
  ctx.watchStorage();
  const seen = Atomics.load(backend.wake.words, backend.wake.index);
  const state = Atomics.load(control.words, Word.state);
  if (state === State.crashed) return { kind: "relayFailed" };
  if (state === State.request) {
    const reply = serveRequest(ctx);
    return reply === undefined ? { kind: "served" } : { kind: "await", reply };
  }

  ctx.woken = false;
  const delay = backend.pump();
  if (backend.drain() > 0) ringDoorbell(ctx);
  stopIfFaulted(ctx);
  const after = Atomics.load(control.words, Word.state);
  if (after === State.request || after === State.crashed) return { kind: "served" };
  return { kind: "idle", seen, delay };
};

// Whether the page has posted messages the host hasn't taken.
export const mailWaiting = (ctx: LoopContext): boolean => Atomics.load(ctx.control.words, Word.mail) !== ctx.mailTaken;

// Serves requests and pumps, sleeping in the backend's wait between them,
// until the pool needs topping up while no request is pending, the page has
// posted a message, or something must wait for the event loop. A backend
// call that throws throws out of here.
export const serveUntilExcursion = (ctx: LoopContext): Excursion => {
  const { backend, instruments } = ctx;
  const { pool, wake } = backend;
  for (;;) {
    const next = step(ctx);
    if (next.kind === "served") continue;
    if (next.kind !== "idle") return next;
    // Checked once step has read the wake word, so that mail posted after
    // this check has moved the word the host then sleeps on.
    if (mailWaiting(ctx)) return { kind: "mail" };
    if (pool !== undefined) {
      const idle = pool.idle();
      if (!ctx.topUpFailed && !instruments.topUpsHeld() && idle < pool.lowWater)
        return { kind: "topUp", pool, want: pool.lowWater - idle };
    }

    // A wait can't tell a word that changed before it slept from one that
    // changed during, so the word is read once more just before the call: a
    // change before that read doesn't count as waking the host. One that
    // lands between that read and the futex wait inside the call, a window
    // of a few instructions, still does.
    const unmoved = Atomics.load(wake.words, wake.index) === next.seen;
    const woke = backend.wait(next.seen, next.delay);
    ctx.woken = unmoved && woke;
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
