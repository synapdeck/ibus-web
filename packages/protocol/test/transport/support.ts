// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { PADDING_KIND, RECORD_ALIGNMENT, RECORD_CONTINUATION } from "../../src/messages/framing.ts";
import {
  MIN_FRAGMENT_PAYLOAD_BYTES,
  RECORD_HEADER_BYTES,
  type TransportLayout,
  type TransportViews,
} from "../../src/transport/layout.ts";
import { alignedSize } from "../../src/transport/ring.ts";

export const ringSizes = [64, 128, 256, 1024] as const;
// Counters at zero, just before the 2³² wrap at several distances, and across the sign bit.
export const counterStarts = [0, 0xfffff000, 0xffffffc8, 0xfffffff8, 0x7ffffff0] as const;

/** A framed record whose header and payload bytes all derive from `seq`. */
export function record(payloadBytes: number, seq: number): Uint8Array {
  const bytes = new Uint8Array(alignedSize(payloadBytes));
  const header = new DataView(bytes.buffer);
  header.setUint32(0, seq, true);
  header.setUint32(4, (seq * 3) >>> 0, true);
  header.setUint16(8, 1 + (seq % 40), true);
  header.setUint32(12, payloadBytes, true);
  for (let i = 0; i < payloadBytes; i++) bytes[RECORD_HEADER_BYTES + i] = (seq * 7 + i) & 255;
  return bytes;
}

/** Payload sizes for a ring: a quarter of them 0–7 bytes, the rest up to three rings. */
export function payloadSizes(seed: number, ringBytes: number, count: number): number[] {
  let state = seed >>> 0;
  const next = (bound: number): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 8) % bound;
  };
  return Array.from({ length: count }, () => (next(4) === 0 ? next(8) : next(ringBytes * 3 + 1)));
}

export interface Published {
  readonly fragments: number;
  readonly padding: number;
}

/** Walks the bytes the writer published between two `ringWrite` values. */
export function published(views: TransportViews, from: number, to: number): Published {
  const ringBytes = views.ring.length;
  let fragments = 0;
  let padding = 0;
  for (let at = from >>> 0; at !== to >>> 0;) {
    const position = at % ringBytes;
    const tail = ringBytes - position;
    if (tail < RECORD_HEADER_BYTES) {
      at = (at + tail) >>> 0;
      continue;
    }
    const header = new DataView(views.ring.buffer, views.ring.byteOffset + position, RECORD_HEADER_BYTES);
    const len = header.getUint32(12, true);
    if (header.getUint16(8, true) === PADDING_KIND) padding++;
    else {
      fragments++;
      if (
        header.getUint16(10, true) === RECORD_CONTINUATION &&
        (len < MIN_FRAGMENT_PAYLOAD_BYTES || len % RECORD_ALIGNMENT !== 0)
      )
        throw new Error(`Short continuation fragment of ${len} bytes`);
    }
    at = (at + alignedSize(len)) >>> 0;
  }
  return { fragments, padding };
}

/** What the writer thread is given. */
export interface WriterData {
  readonly buffer: SharedArrayBuffer;
  readonly layout: TransportLayout;
  readonly status: SharedArrayBuffer;
  readonly seed: number;
  readonly count: number;
  readonly waitMs: number;
}
export const WriterStatus = { running: 0, done: 1, failed: 2, wakeLost: 3 } as const;
