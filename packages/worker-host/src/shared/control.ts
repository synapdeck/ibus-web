// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The dedicated control SharedArrayBuffer between the page and the Worker
// host: a header of Int32 words, then one slot that carries the request and
// then its reply. The page only ever touches this buffer, never the runtime's
// memory.

export const HEADER_BYTES = 64;
export const DEFAULT_SLOT_BYTES: number = 64 * 1024;

// Word indices in the header.
export const Word = {
  // One of State.
  state: 0,
  // Incremented by the page for each request.
  reqSeq: 1,
  // The request's length in the slot.
  reqLen: 2,
  // ibusweb_test_dispatch()'s return value: the reply's length in the slot, or a
  // negative errno.
  replyRet: 3,
  // The word the page increments and notifies after posting a request; the
  // relay forwards it to the word the host sleeps on.
  wake: 4,
} as const;

export const State = {
  idle: 0,
  request: 1,
  reply: 2,
  crashed: 3,
} as const;

export interface ControlViews {
  words: Int32Array;
  slot: Uint8Array;
}

export interface Reply {
  ret: number;
  bytes: Uint8Array;
}

export const createControl = (slotBytes: number = DEFAULT_SLOT_BYTES): SharedArrayBuffer =>
  new SharedArrayBuffer(HEADER_BYTES + slotBytes);

export const controlViews = (buffer: SharedArrayBuffer): ControlViews => ({
  words: new Int32Array(buffer, 0, HEADER_BYTES / 4),
  slot: new Uint8Array(buffer, HEADER_BYTES),
});

// A little-endian uint32 opcode, then the payload.
export const encodeRequest = (opcode: number, payload: Uint8Array = new Uint8Array()): Uint8Array => {
  const request = new Uint8Array(4 + payload.length);
  new DataView(request.buffer).setUint32(0, opcode, true);
  request.set(payload, 4);
  return request;
};

export const requestOpcode = (request: Uint8Array): number =>
  new DataView(request.buffer, request.byteOffset, request.byteLength).getUint32(0, true);

// Page side: the slot must be free (State.idle or a taken reply).
export const postRequest = ({ words, slot }: ControlViews, request: Uint8Array): void => {
  if (request.length > slot.length) throw new RangeError(`request of ${request.length} bytes`);
  slot.set(request);
  Atomics.store(words, Word.reqLen, request.length);
  Atomics.add(words, Word.reqSeq, 1);
  Atomics.store(words, Word.state, State.request);
  Atomics.add(words, Word.wake, 1);
  Atomics.notify(words, Word.wake);
};

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
export const postReply = ({ words, slot }: ControlViews, ret: number, bytes?: Uint8Array): void => {
  if (bytes !== undefined) slot.set(bytes);
  Atomics.store(words, Word.replyRet, ret);
  Atomics.store(words, Word.state, State.reply);
  Atomics.notify(words, Word.state);
};

export const postCrash = ({ words }: ControlViews): void => {
  Atomics.store(words, Word.state, State.crashed);
  Atomics.notify(words, Word.state);
};
