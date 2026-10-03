// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The page's side of the control buffer, as the synchronous keystroke path
// drives it: each call holds the calling thread until the host replies, for
// at most a budget, then waits for the reply without holding it. A reply
// that comes only then is a late reply, which fails the test that made it.

import {
  controlViews,
  encodeRequest,
  postRequest,
  State,
  takeReply,
  Word,
  type Reply,
} from "../../src/shared/control.ts";
import type { Message } from "./testing.ts";

export interface Clock {
  // Milliseconds, from a monotonic clock.
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface BlockingClientEnv extends Clock {
  // Holds the thread while words[index] is value, for at most ms. A thread
  // that can't block, such as a page's main thread, returns at once, and the
  // call spins.
  block(words: Int32Array, index: number, value: number, ms: number): void;
  // How long a call holds its thread.
  budgetMs: number;
  // How a call waits, once its budget has passed, up to ms more for the
  // reply, without holding its thread.
  lateReply: {
    wait(words: Int32Array, index: number, value: number, ms: number): Promise<unknown>;
    ms: number;
  };
}

// A call whose reply came only after the client stopped holding its thread:
// it held it for heldMs, then let it go, and the reply came afterMs later.
export interface LateReply {
  opcode: number;
  heldMs: number;
  afterMs: number;
}

export interface Client {
  call(opcode: number, payload?: Uint8Array): Promise<Reply>;
  // The host's report of why it crashed, or null if none came within
  // timeoutMs.
  crashReport(timeoutMs: number): Promise<string | null>;
  readonly lateReplies: readonly LateReply[];
  // How long each call that held its thread throughout held it, in
  // milliseconds.
  readonly heldMs: readonly number[];
}

// messages are the host's messages after "ready", such as a crash report,
// as the caller's event loop receives them.
export const blockingClient = (
  control: SharedArrayBuffer,
  messages: readonly Message[],
  env: BlockingClientEnv,
): Client => {
  const views = controlViews(control);
  const lateReplies: LateReply[] = [];
  const heldMs: number[] = [];

  const awaitLateReply = async (opcode: number, timedOutAt: number): Promise<Reply> => {
    const deadline = timedOutAt + env.lateReply.ms;
    for (;;) {
      const state = Atomics.load(views.words, Word.state);
      if (state === State.reply) {
        lateReplies.push({ opcode, heldMs: env.budgetMs, afterMs: Number((env.now() - timedOutAt).toFixed(1)) });
        return takeReply(views);
      }
      if (state === State.crashed) throw new Error(`the host crashed on opcode ${opcode}`);
      const left = deadline - env.now();
      if (left <= 0)
        throw new Error(`no reply to opcode ${opcode} in ${env.budgetMs} ms, nor ${env.lateReply.ms} ms after that`);
      await env.lateReply.wait(views.words, Word.state, state, left);
    }
  };

  return {
    lateReplies,
    heldMs,
    call: (opcode, payload) => {
      if (Atomics.load(views.words, Word.state) === State.crashed)
        return Promise.reject(new Error("the host has crashed"));
      postRequest(views, encodeRequest(opcode, payload));
      const postedAt = env.now();
      const deadline = postedAt + env.budgetMs;
      for (;;) {
        const state = Atomics.load(views.words, Word.state);
        if (state === State.reply) {
          heldMs.push(env.now() - postedAt);
          return Promise.resolve(takeReply(views));
        }
        if (state === State.crashed) return Promise.reject(new Error(`the host crashed on opcode ${opcode}`));
        const left = deadline - env.now();
        if (left <= 0) {
          heldMs.push(env.now() - postedAt);
          return awaitLateReply(opcode, env.now());
        }
        env.block(views.words, Word.state, state, left);
      }
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
