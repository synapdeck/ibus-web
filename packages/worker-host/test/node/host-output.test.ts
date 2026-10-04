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
