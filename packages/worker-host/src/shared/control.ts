// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  transportLayout,
  transportViews,
  ReqMode,
  State,
  Word,
  type TransportLayout,
  type TransportViews,
} from "@ibus-web/protocol/transport";

export {
  transportLayout,
  transportViews,
  ReqMode,
  State,
  Word,
  HEADER_BYTES,
  DEFAULT_SLOT_BYTES,
  DEFAULT_RING_BYTES,
  type TransportLayout,
} from "@ibus-web/protocol/transport";
export type ControlViews = TransportViews;
export interface Reply {
  ret: number;
  outSeq: number;
}

export const createControl = (layout: TransportLayout = transportLayout()): SharedArrayBuffer =>
  new SharedArrayBuffer(layout.totalBytes);
export const controlViews = (buffer: SharedArrayBuffer, layout: TransportLayout = transportLayout()): ControlViews =>
  transportViews(buffer, layout);

const requireState = (actual: number, expected: number, message: string): void => {
  if (actual !== expected) throw new Error(actual === State.crashed ? "the host has crashed" : message);
};

export const postRequest = ({ words, slot }: ControlViews, request: Uint8Array, mode: number = ReqMode.sync): void => {
  requireState(Atomics.load(words, Word.state), State.idle, "request slot is not idle");
  if (request.length > slot.length) throw new RangeError(`request of ${request.length} bytes`);
  slot.set(request);
  Atomics.store(words, Word.reqLen, request.length);
  Atomics.add(words, Word.reqSeq, 1);
  Atomics.store(words, Word.reqMode, mode);
  requireState(
    Atomics.compareExchange(words, Word.state, State.idle, State.request),
    State.idle,
    "request slot changed before publication",
  );
  Atomics.add(words, Word.wake, 1);
  Atomics.notify(words, Word.wake);
};

export const takeReply = ({ words }: ControlViews): Reply => {
  requireState(Atomics.load(words, Word.state), State.reply, "no reply in the request slot");
  const ret = Atomics.load(words, Word.replyRet);
  const outSeq = Atomics.load(words, Word.replyOutSeq) >>> 0;
  requireState(
    Atomics.compareExchange(words, Word.state, State.reply, State.idle),
    State.reply,
    "reply state changed before it was taken",
  );
  return { ret, outSeq };
};

export const postReply = ({ words }: ControlViews, ret: number, outSeq: number): boolean => {
  Atomics.store(words, Word.replyRet, ret);
  Atomics.store(words, Word.replyOutSeq, outSeq);
  // A relay can crash concurrently while dispatch is finishing.
  const published = Atomics.compareExchange(words, Word.state, State.request, State.reply) === State.request;
  Atomics.notify(words, Word.state);
  return published;
};

export const postCrash = ({ words }: ControlViews): void => {
  Atomics.store(words, Word.state, State.crashed);
  Atomics.notify(words, Word.state);
};
