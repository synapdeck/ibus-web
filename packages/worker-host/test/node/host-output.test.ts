// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import { RingReader, RingWriter, transportLayout, transportViews, Word } from "@ibus-web/protocol/transport";
import type { Runtime } from "../../src/worker/runtime.ts";
import { drainOutput, writeHostRecord } from "../../src/worker/output.ts";

test("best-effort records reserve tail padding before touching the ring", () => {
  const layout = transportLayout({ slotBytes: 64, ringBytes: 128 });
  const views = transportViews(new SharedArrayBuffer(layout.totalBytes), layout);
  const writer = new RingWriter(views, layout);
  Atomics.store(views.words, Word.ringRead, 80);
  Atomics.store(views.words, Word.ringWrite, 112);
  const payload = new Uint8Array(80);
  expect(writeHostRecord(writer, views, 34, payload)).toBe(false);
  expect(Atomics.load(views.words, Word.ringWrite)).toBe(112);
  expect(views.ring.every((byte) => byte === 0)).toBe(true);
  Atomics.store(views.words, Word.ringRead, 96);
  expect(writeHostRecord(writer, views, 34, payload)).toBe(true);
  expect(Atomics.load(views.words, Word.ringWrite)).toBe(224);
});

test("corrupt ring counters cannot prevent a best-effort crash report", () => {
  const layout = transportLayout({ slotBytes: 64, ringBytes: 128 });
  const views = transportViews(new SharedArrayBuffer(layout.totalBytes), layout);
  const writer = new RingWriter(views, layout);
  Atomics.store(views.words, Word.ringWrite, 136);
  expect(writeHostRecord(writer, views, 34, new Uint8Array(8))).toBe(false);
});

const drainFixture = () => {
  const layout = transportLayout({ slotBytes: 64, ringBytes: 128 });
  const control = transportViews(new SharedArrayBuffer(layout.totalBytes), layout);
  const writer = new RingWriter(control, layout);
  const heap = new Uint8Array(new SharedArrayBuffer(1024));
  const length = new Int32Array(heap.buffer, 0, 1);
  const record = new Uint8Array(272);
  new DataView(record.buffer).setUint16(8, 33, true);
  new DataView(record.buffer).setUint32(12, 256, true);
  heap.set(record, 16);
  let consumed = 0;
  const events: string[] = [];
  const reader = new RingReader(control, layout);
  const rt = {
    HEAPU8: heap,
    _ibusweb_output_peek: () => {
      length[0] = record.length;
      return 16;
    },
    _ibusweb_output_consume: (bytes: number) => {
      consumed += bytes;
    },
    _ibusweb_wait: () => {
      events.push("wait");
      expect(consumed).toBe(0);
      reader.next();
      return 0;
    },
  } as unknown as Runtime;
  const context = {
    control,
    handle: { rt, words: new Int32Array(heap.buffer) },
    wakeIndex: 100,
    constants: { waitTimedOut: -1 },
    postDoorbell: () => {
      events.push("doorbell");
      expect(Atomics.load(control.words, Word.ringWaiting)).toBe(1);
    },
    lastSeq: 0,
  };
  return { writer, length, reader, context, events, consumed: () => consumed };
};

test("full-ring drains resume one immutable record and consume it only when complete", () => {
  const f = drainFixture();
  expect(drainOutput(f.context.handle.rt, f.writer, f.length, f.context)).toBe(1);
  expect(f.events).toEqual(["doorbell", "wait", "wait"]);
  expect(f.consumed()).toBe(272);
  expect(f.reader.next()).toHaveLength(272);
});

test("a page read during the doorbell prevents a lost-wake full-ring sleep", () => {
  const f = drainFixture();
  f.context.handle.rt._ibusweb_wait = () => {
    throw new Error("unexpected full-ring sleep");
  };
  f.context.postDoorbell = () => {
    f.events.push("doorbell");
    Atomics.store(f.context.control.words, Word.doorbell, 0);
    f.reader.next();
  };
  expect(drainOutput(f.context.handle.rt, f.writer, f.length, f.context)).toBe(1);
  expect(f.events).toEqual(["doorbell", "doorbell"]);
  expect(f.consumed()).toBe(272);
});

test("a full-ring wait trap never consumes runtime output afterward", () => {
  const f = drainFixture();
  f.context.handle.rt._ibusweb_wait = () => {
    throw new WebAssembly.RuntimeError("unreachable");
  };
  expect(() => drainOutput(f.context.handle.rt, f.writer, f.length, f.context)).toThrow("unreachable");
  expect(f.consumed()).toBe(0);
  expect(writeHostRecord(f.writer, f.context.control, 34, new Uint8Array(8))).toBe(false);
});

test("a full-ring wait that moves the runtime's output leaves the batch being drained intact", () => {
  const f = drainFixture();
  const bytes = f.context.handle.rt.HEAPU8;
  const large = bytes.slice(16, 288);
  new DataView(large.buffer).setUint32(0, 7, true);
  const small = new Uint8Array(24);
  new DataView(small.buffer).setUint32(0, 8, true);
  new DataView(small.buffer).setUint16(8, 33, true);
  new DataView(small.buffer).setUint32(12, 8, true);
  small.fill(0x5a, 16, 24);
  bytes.set(large, 16);
  bytes.set(small, 288);
  f.context.handle.rt._ibusweb_output_peek = () => {
    f.length[0] = large.length + small.length;
    return 16;
  };
  const read: Uint8Array[] = [];
  const readAll = (): void => {
    for (let next = f.reader.next(); next !== undefined; next = f.reader.next()) read.push(next);
  };
  // A call proxied into the wait appends a record, the buffer moves and its
  // old bytes are reused.
  f.context.handle.rt._ibusweb_wait = () => {
    bytes.fill(0xff, 16, 16 + large.length + small.length);
    readAll();
    return 0;
  };
  expect(drainOutput(f.context.handle.rt, f.writer, f.length, f.context)).toBe(2);
  readAll();
  expect(f.consumed()).toBe(296);
  expect(f.context.lastSeq).toBe(8);
  expect(read).toEqual([large, small]);
});

test("a trap after an earlier complete record does not call consume on the broken runtime", () => {
  const f = drainFixture();
  const bytes = f.context.handle.rt.HEAPU8;
  const large = bytes.slice(16, 288);
  const first = new Uint8Array(24);
  new DataView(first.buffer).setUint16(8, 33, true);
  new DataView(first.buffer).setUint32(12, 8, true);
  bytes.set(first, 16);
  bytes.set(large, 40);
  f.context.handle.rt._ibusweb_output_peek = () => {
    f.length[0] = 296;
    return 16;
  };
  f.context.handle.rt._ibusweb_wait = () => {
    throw new WebAssembly.RuntimeError("unreachable");
  };
  expect(() => drainOutput(f.context.handle.rt, f.writer, f.length, f.context)).toThrow("unreachable");
  expect(f.consumed()).toBe(0);
});

test("a partial tail read before seen re-arms waiting for the remaining page read", () => {
  const f = drainFixture();
  const { control, handle, wakeIndex } = f.context;
  Atomics.store(control.words, Word.ringRead, 120);
  Atomics.store(control.words, Word.ringWrite, 120);
  const occupied = new Uint8Array(120);
  const occupiedHeader = new DataView(occupied.buffer);
  occupiedHeader.setUint32(0, 1, true);
  occupiedHeader.setUint16(8, 33, true);
  occupiedHeader.setUint32(12, 104, true);
  expect(f.writer.write(occupied)).toEqual({ _tag: "written" });
  expect(f.writer.freeBytes()).toBe(0);

  const pending = new Uint8Array(24);
  const pendingHeader = new DataView(pending.buffer);
  pendingHeader.setUint32(0, 2, true);
  pendingHeader.setUint16(8, 33, true);
  pendingHeader.setUint32(12, 8, true);
  handle.rt.HEAPU8.set(pending, 16);
  handle.rt._ibusweb_output_peek = () => {
    f.length[0] = pending.length;
    return 16;
  };

  const pauseAfterTail = new Error("the page pauses after its tail read");
  const notify = Atomics.notify;
  let paused = false;
  let bells = 0;
  let waits = 0;
  Atomics.notify = ((words: Int32Array, index: number, count?: number): number => {
    const result = notify(words, index, count);
    if (words === control.words && index === Word.wake && !paused) {
      paused = true;
      // Forward the completed read's wake before the host samples seen.
      Atomics.store(handle.words, wakeIndex, Atomics.load(control.words, Word.wake));
      throw pauseAfterTail;
    }
    return result;
  }) as typeof Atomics.notify;
  f.context.postDoorbell = () => {
    bells++;
    Atomics.store(control.words, Word.doorbell, 0);
    if (bells !== 1) return;
    try {
      f.reader.next();
    } catch (error) {
      if (error !== pauseAfterTail) throw error;
    }
    expect(paused).toBe(true);
    expect(Atomics.load(control.words, Word.ringRead)).toBe(128);
    expect(Atomics.load(control.words, Word.ringWaiting)).toBe(0);
    expect(f.writer.freeBytes()).toBe(8);
  };
  handle.rt._ibusweb_wait = (seen, delay) => {
    waits++;
    expect(delay).toBe(-1);
    expect(f.consumed()).toBe(0);
    const waiting = Atomics.load(control.words, Word.ringWaiting);
    expect(f.reader.next()).toEqual(occupied);
    Atomics.store(handle.words, wakeIndex, Atomics.load(control.words, Word.wake));
    // An indefinite wait could return only if this remaining read wakes it.
    expect(Atomics.load(handle.words, wakeIndex), "remaining page read must wake the host").not.toBe(seen);
    expect(waiting).toBe(1);
    return 0;
  };
  try {
    expect(drainOutput(handle.rt, f.writer, f.length, f.context)).toBe(1);
    expect(bells).toBe(2);
    expect(waits).toBe(1);
    expect(f.consumed()).toBe(24);
    expect(f.reader.next()).toEqual(pending);
  } finally {
    Atomics.notify = notify;
  }
});
