// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Forwards wakes from one Int32 word to another, for a host that can sleep
// on only one: each change of the source word increments the target and
// notifies its waiters. It blocks in Atomics.wait() for good once started,
// so it needs no event loop turn to forward anything; changes that land
// while it forwards are folded into one wake, which is all a waiter needs.

export interface RelayWord {
  buffer: SharedArrayBuffer;
  index: number;
}

export interface RelayInit {
  from: RelayWord;
  to: RelayWord;
}

self.onmessage = ({ data }: MessageEvent<RelayInit>) => {
  self.onmessage = null;
  const from = new Int32Array(data.from.buffer);
  const to = new Int32Array(data.to.buffer);
  // The value last forwarded, not one read after forwarding: a change that
  // lands while forwarding must make the next wait return at once.
  let seen = Atomics.load(from, data.from.index);
  self.postMessage("ready");
  for (;;) {
    Atomics.wait(from, data.from.index, seen);
    const now = Atomics.load(from, data.from.index);
    if (now === seen) continue;
    seen = now;
    Atomics.add(to, data.to.index, 1);
    Atomics.notify(to, data.to.index);
  }
};
