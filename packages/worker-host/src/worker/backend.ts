// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the request loop needs of whatever runs the module's engines. Every
// call runs inside the loop's synchronous section, so none may rely on the
// event loop; a throw stops the host.

// A word in shared memory that moves whenever the host should look for work.
export interface WakeWord {
  readonly words: Int32Array;
  readonly index: number;
}

// fault, when set, is the message the host crashes with once the request's
// output and reply are published: the module faulted serving it.
export interface Dispatched {
  readonly ret: number;
  readonly fault?: string;
}

// Workers the module's threads run on, which the host adds from its event
// loop.
export interface Pool {
  // Below this many idle Workers, the host tops the pool up.
  readonly lowWater: number;
  readonly idle: () => number;
  // Settles once want more Workers have joined the pool, or rejects once
  // limitMs has passed.
  readonly topUp: (want: number, limitMs: number) => Promise<{ ms: number; createMs: number }>;
  // Runs a thread on every idle Worker, returning how many ran.
  readonly warm: () => number;
}

export interface Backend {
  readonly wake: WakeWord;
  // Serves one framed request.
  readonly dispatch: (request: Uint8Array) => Dispatched;
  // Runs the work that has come due, returning the delay until more is, in
  // milliseconds, or -1 for none.
  readonly pump: () => number;
  // Publishes the records written since the last drain to the ring, in
  // order, returning how many.
  readonly drain: () => number;
  // Sleeps until the wake word moves from seen, or for timeoutMs (-1 for no
  // limit). False once it timed out.
  readonly wait: (seen: number, timeoutMs: number) => boolean;
  // The message the host crashes with once the module has faulted outside a
  // request.
  readonly fault: () => string | undefined;
  readonly pool: Pool | undefined;
  // Destroys the engines still open, as the host closes; intact says the
  // module may still be called.
  readonly close: (intact: boolean) => void;
}
