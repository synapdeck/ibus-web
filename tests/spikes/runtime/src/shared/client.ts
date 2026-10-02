// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The page's side of the control buffer. As the synchronous keystroke path
// would drive it, each call holds the calling thread until the host replies;
// for comparison, a call can instead wait without holding the thread.

import {
  controlViews,
  encodeRequest,
  postRequest,
  State,
  takeReply,
  Word,
  type HostMessage,
  type Reply,
} from "./control.ts";
import type { Client, LateReply } from "./scenarios.ts";

export interface BlockingClientEnv {
  // Milliseconds, from a monotonic clock.
  now(): number;
  sleep(ms: number): Promise<void>;
  // Holds the thread while words[index] is value, for at most ms. A thread
  // that can't block, such as a page's main thread, returns at once, and the
  // call spins. A promise instead lets the thread go until it settles.
  block(words: Int32Array, index: number, value: number, ms: number): void | Promise<unknown>;
  replyTimeoutMs: number;
  // Once replyTimeoutMs has passed, how a caller that can wait without
  // holding its thread waits up to ms more for the reply. A reply that
  // comes then still counts against the call, as a late reply, but the host
  // stays in step for the calls after it.
  lateReply?: {
    wait(words: Int32Array, index: number, value: number, ms: number): Promise<unknown>;
    ms: number;
  };
}

// messages are the host's messages after "ready", such as a crash report,
// as the caller's event loop receives them.
export const blockingClient = (
  control: SharedArrayBuffer,
  messages: readonly HostMessage[],
  env: BlockingClientEnv,
): Client => {
  const views = controlViews(control);
  const lateReplies: LateReply[] = [];
  const heldMs: number[] = [];

  // After the blocking wait has given up.
  const awaitLateReply = async (opcode: number, timedOutAt: number): Promise<Reply> => {
    const late = env.lateReply;
    const deadline = timedOutAt + (late?.ms ?? 0);
    for (;;) {
      const state = Atomics.load(views.words, Word.state);
      if (state === State.reply) {
        lateReplies.push({
          opcode,
          heldMs: env.replyTimeoutMs,
          afterMs: Number((env.now() - timedOutAt).toFixed(1)),
        });
        return takeReply(views);
      }
      if (state === State.crashed) throw new Error(`the host crashed on opcode ${opcode}`);
      const left = deadline - env.now();
      if (late === undefined || left <= 0)
        throw new Error(
          `no reply to opcode ${opcode} in ${env.replyTimeoutMs} ms` +
            (late === undefined ? "" : `, nor ${late.ms} ms after that`),
        );
      await late.wait(views.words, Word.state, state, left);
    }
  };

  return {
    lateReplies,
    heldMs,
    call: (opcode, payload) => {
      if (Atomics.load(views.words, Word.state) === State.crashed) {
        return Promise.reject(new Error("the host has crashed"));
      }
      postRequest(views, encodeRequest(opcode, payload));
      const postedAt = env.now();
      const deadline = postedAt + env.replyTimeoutMs;
      // Whether the call has held the thread throughout so far.
      let holding = true;
      const held = (): void => {
        if (holding) heldMs.push(env.now() - postedAt);
      };
      const wait = (): Promise<Reply> => {
        for (;;) {
          const state = Atomics.load(views.words, Word.state);
          if (state === State.reply) {
            held();
            return Promise.resolve(takeReply(views));
          }
          if (state === State.crashed) return Promise.reject(new Error(`the host crashed on opcode ${opcode}`));
          const left = deadline - env.now();
          if (left <= 0) {
            held();
            return awaitLateReply(opcode, env.now());
          }
          const later = env.block(views.words, Word.state, state, left);
          if (later !== undefined) {
            holding = false;
            return later.then(wait);
          }
        }
      };
      return wait();
    },
    crashReport: async (timeoutMs) => {
      const deadline = env.now() + timeoutMs;
      for (;;) {
        const crash = messages.find(({ type }) => type === "crashed");
        if (crash !== undefined && "message" in crash) return crash.message;
        if (env.now() >= deadline) return null;
        await env.sleep(10);
      }
    },
  };
};

// The smallest step a clock takes, in microseconds, over up to samples
// readings. Browsers coarsen performance.now(), by how much depending on
// the engine and on cross-origin isolation.
export const clockStepUs = (now: () => number, samples = 100_000): number => {
  let step = Infinity;
  let last = now();
  for (let i = 0; i < samples; i++) {
    const t = now();
    if (t > last) step = Math.min(step, t - last);
    last = t;
  }
  return Number((step * 1000).toFixed(3));
};
