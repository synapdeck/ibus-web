// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
export const Word = {
  state: 0,
  reqSeq: 1,
  reqLen: 2,
  replyRet: 3,
  replyOutSeq: 4,
  ringWrite: 5,
  ringRead: 6,
  ringWaiting: 7,
  doorbell: 8,
  wake: 9,
  reqMode: 10,
} as const;
export const State = { idle: 0, request: 1, reply: 2, crashed: 3 } as const;
export const ReqMode = { sync: 0, async: 1, abandoned: 2 } as const;
export const HEADER_BYTES = 64;
export const DEFAULT_SLOT_BYTES = 65536;
export const DEFAULT_RING_BYTES = 262144;
export const wordDescriptions: Record<keyof typeof Word, { writer: string; description: string }> = {
  state: { writer: "both", description: "IDLE 0, REQUEST 1, REPLY 2, CRASHED 3." },
  reqSeq: { writer: "page", description: "Request sequence for diagnostics; ignored by the host." },
  reqLen: { writer: "page", description: "Request bytes in the slot." },
  replyRet: { writer: "host", description: "Return value of ibusweb_dispatch." },
  replyOutSeq: { writer: "host", description: "Last runtime record produced by dispatch and pump; unchanged if none." },
  ringWrite: { writer: "host", description: "Bytes written modulo 2³²." },
  ringRead: { writer: "page", description: "Bytes consumed modulo 2³²." },
  ringWaiting: { writer: "both", description: "Host sets 1 before waiting; page clears after freeing space." },
  doorbell: { writer: "both", description: "1 while a doorbell is outstanding; page clears before draining." },
  wake: { writer: "page", description: "Bumped and notified after requests and freeing space for a waiting host." },
  reqMode: { writer: "both", description: "SYNC 0, ASYNC 1, ABANDONED 2." },
};
export interface TransportLayout {
  readonly slotBytes: number;
  readonly ringBytes: number;
  readonly totalBytes: number;
  readonly slotOffset: number;
  readonly ringOffset: number;
}
export interface TransportViews {
  readonly words: Int32Array;
  readonly slot: Uint8Array;
  readonly ring: Uint8Array;
}
export function transportLayout(options: { slotBytes?: number; ringBytes?: number } = {}): TransportLayout {
  const slotBytes = options.slotBytes ?? DEFAULT_SLOT_BYTES;
  const ringBytes = options.ringBytes ?? DEFAULT_RING_BYTES;
  if (!Number.isSafeInteger(slotBytes) || slotBytes <= 0 || slotBytes % 8 !== 0)
    throw new RangeError("Slot size must be a positive multiple of 8");
  if (
    !Number.isSafeInteger(ringBytes) ||
    ringBytes < 64 ||
    ringBytes > 2 ** 31 ||
    !Number.isInteger(Math.log2(ringBytes))
  )
    throw new RangeError("Ring size must be a power of two from 64 to 2³¹ bytes");
  const totalBytes = HEADER_BYTES + slotBytes + ringBytes;
  if (!Number.isSafeInteger(totalBytes)) throw new RangeError("Transport size exceeds safe integer range");
  return { slotBytes, ringBytes, totalBytes, slotOffset: HEADER_BYTES, ringOffset: HEADER_BYTES + slotBytes };
}
export function transportViews(buffer: SharedArrayBuffer, layout: TransportLayout): TransportViews {
  const expected = transportLayout(layout);
  if (
    layout.totalBytes !== expected.totalBytes ||
    layout.slotOffset !== expected.slotOffset ||
    layout.ringOffset !== expected.ringOffset
  )
    throw new RangeError("Invalid transport offsets");
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== layout.totalBytes)
    throw new RangeError("Shared buffer must match the transport layout");
  return {
    words: new Int32Array(buffer, 0, HEADER_BYTES / 4),
    slot: new Uint8Array(buffer, layout.slotOffset, layout.slotBytes),
    ring: new Uint8Array(buffer, layout.ringOffset, layout.ringBytes),
  };
}
