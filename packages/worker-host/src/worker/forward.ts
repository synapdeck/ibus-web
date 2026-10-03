// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The wake relay: forwards wakes from one Int32 word to another, for a host
// that can sleep on only one. Each change of the source word increments the
// target and notifies its waiters. It blocks in Atomics.wait() for good once
// started, so it needs no event loop turn to forward anything; changes that
// land while it forwards are folded into one wake, which is all a waiter
// needs.

import { controlViews, postCrash } from "../shared/control.ts";

export interface RelayWord {
  buffer: SharedArrayBuffer;
  index: number;
}

export interface RelayInit {
  from: RelayWord;
  to: RelayWord;
  control: SharedArrayBuffer;
}

export type Wait = (words: Int32Array, index: number, value: number) => unknown;

const bump = (words: Int32Array, index: number): void => {
  Atomics.add(words, index, 1);
  Atomics.notify(words, index);
};

// Calls ready() once it is forwarding, then forwards for good; it returns
// only by throwing.
export const forward = (init: RelayInit, ready: () => void, wait: Wait = Atomics.wait): never => {
  const from = new Int32Array(init.from.buffer);
  const to = new Int32Array(init.to.buffer);
  // The value last forwarded, not one read after forwarding: a change that
  // lands while forwarding must make the next wait return at once.
  let seen = Atomics.load(from, init.from.index);
  ready();
  try {
    for (;;) {
      wait(from, init.from.index, seen);
      const now = Atomics.load(from, init.from.index);
      if (now === seen) continue;
      seen = now;
      bump(to, init.to.index);
    }
  } catch (error) {
    // Without the relay the host sleeps through every request, and a
    // sleeping host runs no event loop to hear of this error: the control
    // buffer says so first, and the host, which sleeps on one of the two
    // words, wakes to read it.
    postCrash(controlViews(init.control));
    bump(from, init.from.index);
    bump(to, init.to.index);
    throw error;
  }
};
