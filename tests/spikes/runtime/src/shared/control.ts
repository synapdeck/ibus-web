// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The dedicated control SharedArrayBuffer between the page and the Worker
// host: a header of Int32 words, then one slot that carries the request and
// then its reply. The page only ever touches this buffer, never the runtime's
// memory.

export const HEADER_BYTES = 64;
export const DEFAULT_SLOT_BYTES = 64 * 1024;

// Word indices in the header.
export const Word = {
  // One of State.
  state: 0,
  // Incremented by the page for each request.
  reqSeq: 1,
  // The request's length in the slot.
  reqLen: 2,
  // ibusweb_dispatch()'s return value: the reply's length in the slot, or a
  // negative errno.
  replyRet: 3,
  // The word the host sleeps on: the page increments it and notifies after
  // posting a request.
  wake: 4,
} as const;

export const State = {
  idle: 0,
  request: 1,
  reply: 2,
  crashed: 3,
} as const;

// Spike instruments, not protocol: requests the spike's host answers itself,
// outside the runtime's opcode space, so scenarios can observe and steer it.
// A real host has neither.
export const HostOp = {
  // A UTF-8 JSON HostStats.
  stats: 0xffff_0001,
  // Returns the host to its event loop for the int32 payload's milliseconds
  // (10 if none), then replies 0.
  yield: 0xffff_0002,
  // Holds off topping the pool up while the int32 payload is 0, and allows
  // it again otherwise; replies 0.
  topUp: 0xffff_0003,
} as const;

// A spike instrument: what HostOp.stats reports.
export interface HostStats {
  // Workers Emscripten created after the runtime started, beyond its pool.
  workersCreated: number;
  // Workers in Emscripten's pool that host no thread and can take one.
  idleWorkers: number;
  // Pool top-ups finished, the Workers they added, and how long the last
  // took from its first new Worker to its last one loaded.
  topUps: number;
  topUpWorkers: number;
  lastTopUpMs: number | null;
  // Of that, how long the last top-up's new Worker() calls took.
  lastTopUpCreateMs: number | null;
  // Times the host has left ibusweb_wait() for its event loop: a top-up or
  // a yield.
  eventLoopTurns: number;
  // Bytes malloc() has handed out and not had back.
  heapInUse: number;
  // Requests the host has served, this one included.
  requests: number;
  // Of those, the ones that arrived while the host slept: it found them
  // when its wait returned rather than before starting one.
  requestsWhileAsleep: number;
}

// Values the C side defines, printed by the build for the WebAssembly
// target.
export interface BuildConstants {
  // The spike side modules' opcodes, by their C names without SPIKE_OP_.
  ops: Readonly<Record<string, number>>;
  // IBUSWEB_PUMP_ERROR.
  pumpError: number;
  // ibusweb_wait()'s -ETIMEDOUT.
  waitTimedOut: number;
  // struct mallinfo's size, and the offset of uordblks (bytes in use).
  mallinfo: { bytes: number; inUseOffset: number };
}

// How the host sleeps between requests.
//  - "runtime": in ibusweb_wait(), on a word in the runtime's memory that
//    GLib's wake hook bumps; a relay Worker bumps it for the page.
//  - "runtime-async": in Atomics.waitAsync() on that same word, so the
//    host's event loop runs while it is idle.
//  - "control": in Atomics.wait() on Word.wake, which the page bumps, so a
//    request reaches the host without the relay; a relay Worker bumps the
//    word for GLib's wake hook instead. This is the relay-less comparison
//    for the request path, not a design: the host's sleep runs no proxied
//    calls.
export type WaitMode = "runtime" | "runtime-async" | "control";

export type Storage =
  | { kind: "memory" }
  // A WasmFS Node backend over hostPath, mounted at mountPath.
  | { kind: "node"; hostPath: string; mountPath: string }
  // WasmFS's OPFS backend, the origin's whole private file system, mounted
  // at mountPath.
  | { kind: "opfs"; mountPath: string };

export interface SideModule {
  name: string;
  bytes: ArrayBuffer;
}

// The page's first and only message to the host. Wasm is the runtime's
// compiled WebAssembly.Module, typed by the environment that has one.
export interface HostInit<Wasm = unknown> {
  runtimeUrl: string;
  // The host tops Emscripten's pthread pool up, when no request is pending,
  // to this many idle Workers.
  poolLowWater: number;
  wasm?: Wasm;
  control: SharedArrayBuffer;
  sides: SideModule[];
  storage: Storage;
  wait: WaitMode;
  constants: BuildConstants;
}

// A spike instrument: what the host's Worker offers that the host or
// Emscripten's runtime relies on, and the step its performance.now() takes.
export interface HostFeatures {
  atomicsWaitAsync: boolean;
  syncAccessHandle: boolean;
  clockStepUs: number;
}

export type HostMessage =
  | { type: "ready"; startupMs: number; features: HostFeatures }
  | { type: "error"; message: string }
  | { type: "crashed"; message: string };

export interface ControlViews {
  words: Int32Array;
  slot: Uint8Array;
}

export const createControl = (
  slotBytes = DEFAULT_SLOT_BYTES,
): SharedArrayBuffer => new SharedArrayBuffer(HEADER_BYTES + slotBytes);

export const controlViews = (buffer: SharedArrayBuffer): ControlViews => ({
  words: new Int32Array(buffer, 0, HEADER_BYTES / 4),
  slot: new Uint8Array(buffer, HEADER_BYTES),
});

// A little-endian uint32 opcode, then the payload.
export const encodeRequest = (
  opcode: number,
  payload: Uint8Array = new Uint8Array(),
): Uint8Array => {
  const request = new Uint8Array(4 + payload.length);
  new DataView(request.buffer).setUint32(0, opcode, true);
  request.set(payload, 4);
  return request;
};

export const requestOpcode = (request: Uint8Array): number =>
  new DataView(
    request.buffer,
    request.byteOffset,
    request.byteLength,
  ).getUint32(0, true);

// Page side: the slot must be free (State.idle or a taken reply).
export const postRequest = (
  { words, slot }: ControlViews,
  request: Uint8Array,
): void => {
  if (request.length > slot.length)
    throw new RangeError(`request of ${request.length} bytes`);
  slot.set(request);
  Atomics.store(words, Word.reqLen, request.length);
  Atomics.add(words, Word.reqSeq, 1);
  Atomics.store(words, Word.state, State.request);
  Atomics.add(words, Word.wake, 1);
  Atomics.notify(words, Word.wake);
};

export interface Reply {
  ret: number;
  bytes: Uint8Array;
}

// Page side, once the state is State.reply: copies the reply out and frees
// the slot.
export const takeReply = ({ words, slot }: ControlViews): Reply => {
  const ret = Atomics.load(words, Word.replyRet);
  const bytes = ret > 0 ? slot.slice(0, ret) : new Uint8Array();
  Atomics.store(words, Word.state, State.idle);
  return { ret, bytes };
};

// Host side, once the state is State.request: the request, still in the slot.
export const requestBytes = ({ words, slot }: ControlViews): Uint8Array =>
  slot.subarray(0, Atomics.load(words, Word.reqLen));

// Host side: reply bytes, or nothing when ret is an error.
export const postReply = (
  { words, slot }: ControlViews,
  ret: number,
  bytes?: Uint8Array,
): void => {
  if (bytes !== undefined) slot.set(bytes);
  Atomics.store(words, Word.replyRet, ret);
  Atomics.store(words, Word.state, State.reply);
  Atomics.notify(words, Word.state);
};

export const postCrash = ({ words }: ControlViews): void => {
  Atomics.store(words, Word.state, State.crashed);
  Atomics.notify(words, Word.state);
};
