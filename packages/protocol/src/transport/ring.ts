// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { PADDING_KIND, RECORD_ALIGNMENT, RECORD_CONTINUATION } from "../messages/framing.ts";
import {
  MIN_FRAGMENT_PAYLOAD_BYTES as MIN_FRAGMENT_PAYLOAD,
  RECORD_HEADER_BYTES as HEADER_SIZE,
  Word,
  type TransportLayout,
  type TransportViews,
} from "./layout.ts";
// A record's bytes in the ring: its header and payload, padded to the
// record alignment.
export const alignedSize = (payloadBytes: number): number =>
  Math.ceil((HEADER_SIZE + payloadBytes) / RECORD_ALIGNMENT) * RECORD_ALIGNMENT;
const headerOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
export type WriteResult = { readonly _tag: "written" } | { readonly _tag: "full"; readonly needBytes: number };

export class RingWriter {
  private pending: { record: Uint8Array; offset: number; payloadBytes: number } | undefined;
  private readonly views: TransportViews;
  private readonly layout: TransportLayout;
  constructor(views: TransportViews, layout: TransportLayout) {
    this.views = views;
    this.layout = layout;
  }
  freeBytes(): number {
    const used = (Atomics.load(this.views.words, Word.ringWrite) - Atomics.load(this.views.words, Word.ringRead)) >>> 0;
    if (used > this.layout.ringBytes) throw new Error("Invalid ring counters");
    return this.layout.ringBytes - used;
  }
  /** Resume with the same immutable record. needBytes is the minimum free space
   * required for the next fragment, including a tail skip when necessary. */
  write(record: Uint8Array): WriteResult {
    if (this.pending && this.pending.record !== record) throw new Error("Resume with the same record");
    if (!this.pending) {
      if (record.length < HEADER_SIZE) throw new Error("Truncated record header");
      const header = headerOf(record);
      const payloadBytes = header.getUint32(12, true);
      if (
        header.getUint16(8, true) === PADDING_KIND ||
        header.getUint16(10, true) !== 0 ||
        record.length !== alignedSize(payloadBytes)
      )
        throw new Error("Invalid record framing");
      if (record.subarray(HEADER_SIZE + payloadBytes).some((byte) => byte !== 0))
        throw new Error("Nonzero record padding");
      this.pending = { record, offset: 0, payloadBytes };
    }
    const pending = this.pending;
    while (true) {
      const write = Atomics.load(this.views.words, Word.ringWrite) >>> 0;
      const position = write % this.layout.ringBytes;
      const tail = this.layout.ringBytes - position;
      const free = this.freeBytes();
      const remaining = pending.payloadBytes - pending.offset;
      const minimum = alignedSize(Math.min(MIN_FRAGMENT_PAYLOAD, remaining));
      if (tail < HEADER_SIZE) {
        if (free < tail) return { _tag: "full", needBytes: tail + minimum };
        this.publish(write, tail);
        continue;
      }
      if (free < minimum) return { _tag: "full", needBytes: tail < minimum ? tail + minimum : minimum };
      const payloadBytes =
        alignedSize(remaining) <= free
          ? remaining
          : Math.floor((free - HEADER_SIZE) / RECORD_ALIGNMENT) * RECORD_ALIGNMENT;
      const size = alignedSize(payloadBytes);
      if (size > tail) {
        const padding = new Uint8Array(tail);
        headerOf(padding).setUint32(12, tail - HEADER_SIZE, true);
        this.views.ring.set(padding, position);
        this.publish(write, tail);
        continue;
      }
      const fragment = new Uint8Array(size);
      fragment.set(record.subarray(0, HEADER_SIZE));
      const header = headerOf(fragment);
      header.setUint16(10, payloadBytes < remaining ? RECORD_CONTINUATION : 0, true);
      header.setUint32(12, payloadBytes, true);
      fragment.set(
        record.subarray(HEADER_SIZE + pending.offset, HEADER_SIZE + pending.offset + payloadBytes),
        HEADER_SIZE,
      );
      this.views.ring.set(fragment, position);
      this.publish(write, size);
      pending.offset += payloadBytes;
      if (pending.offset === pending.payloadBytes) {
        this.pending = undefined;
        return { _tag: "written" };
      }
    }
  }
  private publish(write: number, bytes: number): void {
    // Release publication keeps the reader from observing partially copied bytes.
    Atomics.store(this.views.words, Word.ringWrite, (write + bytes) | 0);
  }
}

export class RingReader {
  private fragments: Uint8Array[] = [];
  private firstHeader: Uint8Array | undefined;
  private payloadBytes = 0;
  private readonly views: TransportViews;
  private readonly layout: TransportLayout;
  constructor(views: TransportViews, layout: TransportLayout) {
    this.views = views;
    this.layout = layout;
  }
  /** Returning false pauses before the next ring unit; partial fragments survive the pause. */
  next(canContinue?: () => boolean): Uint8Array | undefined {
    while (canContinue?.() ?? true) {
      const read = Atomics.load(this.views.words, Word.ringRead) >>> 0;
      const available = (Atomics.load(this.views.words, Word.ringWrite) - read) >>> 0;
      if (available === 0) return undefined;
      if (available > this.layout.ringBytes) throw new Error("Invalid ring counters");
      const position = read % this.layout.ringBytes;
      const tail = this.layout.ringBytes - position;
      if (tail < HEADER_SIZE) {
        if (available < tail) throw new Error("Incomplete ring tail");
        this.consume(read, tail);
        continue;
      }
      if (available < HEADER_SIZE) throw new Error("Incomplete ring header");
      const header = headerOf(this.views.ring.subarray(position));
      const len = header.getUint32(12, true);
      const size = alignedSize(len);
      const flags = header.getUint16(10, true);
      const kind = header.getUint16(8, true);
      if (size > tail || size > available || (flags !== 0 && flags !== RECORD_CONTINUATION))
        throw new Error("Invalid ring record framing");
      if (kind === PADDING_KIND) {
        if (size !== tail || flags !== 0 || header.getUint32(0, true) !== 0 || header.getUint32(4, true) !== 0)
          throw new Error("Invalid padding record");
        this.consume(read, size);
        continue;
      }
      if (flags === RECORD_CONTINUATION && (len < MIN_FRAGMENT_PAYLOAD || len % RECORD_ALIGNMENT !== 0))
        throw new Error("Invalid continuation payload");
      const bytes = this.views.ring.slice(position, position + size);
      if (bytes.subarray(HEADER_SIZE + len).some((byte) => byte !== 0)) throw new Error("Nonzero ring padding");
      if (this.firstHeader) {
        const first = headerOf(this.firstHeader);
        if (
          first.getUint32(0, true) !== header.getUint32(0, true) ||
          first.getUint32(4, true) !== header.getUint32(4, true) ||
          first.getUint16(8, true) !== kind
        )
          throw new Error("Fragment identity changed");
      } else this.firstHeader = bytes.slice(0, HEADER_SIZE);
      this.fragments.push(bytes.subarray(HEADER_SIZE, HEADER_SIZE + len));
      this.payloadBytes += len;
      if (this.payloadBytes > 0xffffffff) throw new Error("Reassembled payload exceeds uint32 length");
      this.consume(read, size);
      if (flags === RECORD_CONTINUATION) continue;
      const record = new Uint8Array(alignedSize(this.payloadBytes));
      record.set(this.firstHeader);
      const completeHeader = headerOf(record);
      completeHeader.setUint16(10, 0, true);
      completeHeader.setUint32(12, this.payloadBytes, true);
      let offset = HEADER_SIZE;
      for (const fragment of this.fragments) {
        record.set(fragment, offset);
        offset += fragment.length;
      }
      this.fragments = [];
      this.firstHeader = undefined;
      this.payloadBytes = 0;
      return record;
    }
  }
  private consume(read: number, size: number): void {
    Atomics.store(this.views.words, Word.ringRead, (read + size) | 0);
    if (Atomics.exchange(this.views.words, Word.ringWaiting, 0) === 1) {
      Atomics.add(this.views.words, Word.wake, 1);
      Atomics.notify(this.views.words, Word.wake);
    }
  }
}
