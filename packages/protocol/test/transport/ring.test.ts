// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it, test } from "@effect/vitest";
import { Schema } from "effect";
import { RingReader, RingWriter, transportLayout, transportViews, Word, RECORD_CONTINUATION } from "../../src/index.ts";
import { published } from "./support.ts";
function record(payloadBytes: number, seq = 1): Uint8Array {
  const bytes = new Uint8Array(Math.ceil((16 + payloadBytes) / 8) * 8);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, seq, true);
  header.setUint32(4, 7, true);
  header.setUint16(8, 33, true);
  header.setUint32(12, payloadBytes, true);
  for (let i = 0; i < payloadBytes; i++) bytes[16 + i] = i % 251;
  return bytes;
}
function setup(start = 0) {
  const layout = transportLayout({ slotBytes: 64, ringBytes: 64 });
  const views = transportViews(new SharedArrayBuffer(layout.totalBytes), layout);
  Atomics.store(views.words, Word.ringRead, start);
  Atomics.store(views.words, Word.ringWrite, start);
  return { views, writer: new RingWriter(views, layout), reader: new RingReader(views, layout) };
}
test("delivers records in order and hides padding and short tail skips", () => {
  for (const start of [0, 40, 56, 0xfffff000]) {
    const { writer, reader } = setup(start);
    for (let seq = 1; seq <= 200; seq++) {
      const input = record(8, seq);
      while (writer.write(input)._tag === "full") expect(reader.next()).toBeUndefined();
      expect(reader.next()).toEqual(input);
    }
  }
});
test("resumes fragments with shared identity and continuation flags", () => {
  const { views, writer, reader } = setup();
  const input = record(170);
  expect(writer.write(input)).toEqual({ _tag: "full", needBytes: 24 });
  const header = new DataView(views.ring.buffer, views.ring.byteOffset);
  expect(header.getUint32(0, true)).toBe(1);
  expect(header.getUint32(4, true)).toBe(7);
  expect(header.getUint16(8, true)).toBe(33);
  expect(header.getUint16(10, true)).toBe(RECORD_CONTINUATION);
  expect(reader.next()).toBeUndefined();
  while (writer.write(input)._tag === "full") {
    expect(reader.next()).toBeUndefined();
  }
  const output = reader.next();
  expect(output).toEqual(input);
});
test("wakes a waiting writer after consumption", () => {
  const { views, writer, reader } = setup();
  writer.write(record(8));
  Atomics.store(views.words, Word.ringWaiting, 1);
  reader.next();
  expect(Atomics.load(views.words, Word.ringWaiting)).toBe(0);
  expect(Atomics.load(views.words, Word.wake)).toBe(1);
});
it.prop(
  "random sizes and read interleavings deliver each record once",
  [Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 192 }))), Schema.Array(Schema.Boolean)],
  ([sizes, reads]) => {
    const { writer, reader } = setup();
    const expected = sizes.map((size, i) => record(size, i + 1));
    const actual: Uint8Array[] = [];
    let step = 0;
    const read = () => {
      const result = reader.next();
      if (result) actual.push(result);
    };
    for (const input of expected) {
      while (writer.write(input)._tag === "full") read();
      if (reads[step++ % Math.max(1, reads.length)]) read();
    }
    while (actual.length < expected.length) {
      const result = reader.next();
      expect(result).toBeDefined();
      actual.push(result!);
    }
    expect(actual).toEqual(expected);
  },
  { arbitrary: { runs: 100, seed: 104 } },
);
test("fragments a record that fits the ring when available space is smaller", () => {
  const { writer, reader, views } = setup();
  const first = record(8);
  const second = record(32, 2);
  expect(writer.write(first)._tag).toBe("written");
  expect(writer.write(second)).toEqual({ _tag: "full", needBytes: 24 });
  const header = new DataView(views.ring.buffer, views.ring.byteOffset + 24);
  expect(header.getUint16(10, true)).toBe(RECORD_CONTINUATION);
  expect(header.getUint32(12, true)).toBe(24);
  expect(reader.next()).toEqual(first);
  expect(reader.next()).toBeUndefined();
  expect(writer.write(second)._tag).toBe("written");
  expect(reader.next()).toEqual(second);
});
test("rejects malformed records and changing a pending record", () => {
  const { writer } = setup();
  expect(() => writer.write(new Uint8Array(8))).toThrow("Truncated");
  const invalid = record(8);
  new DataView(invalid.buffer).setUint16(8, 0, true);
  expect(() => writer.write(invalid)).toThrow("framing");
  writer.write(record(170));
  expect(() => writer.write(record(170))).toThrow("same record");
});
test("asks for exactly the free space the next fragment needs on a 64-byte ring", () => {
  const ringBytes = 64;
  const layout = transportLayout({ slotBytes: 8, ringBytes });
  // Replays the same first write so each probe starts from the writer's state after it.
  const start = (position: number, free: number, payloadBytes: number) => {
    const views = transportViews(new SharedArrayBuffer(layout.totalBytes), layout);
    Atomics.store(views.words, Word.ringWrite, position);
    Atomics.store(views.words, Word.ringRead, position - (ringBytes - free));
    const writer = new RingWriter(views, layout);
    const input = record(payloadBytes);
    return { views, writer, input, result: writer.write(input) };
  };
  const probe = (position: number, free: number, payloadBytes: number, freeAfter: number) => {
    const { views, writer, input } = start(position, free, payloadBytes);
    Atomics.add(views.words, Word.ringRead, freeAfter - writer.freeBytes());
    const before = Atomics.load(views.words, Word.ringWrite);
    const result = writer.write(input);
    return (
      result._tag === "written" || published(views, before, Atomics.load(views.words, Word.ringWrite)).fragments > 0
    );
  };
  let probes = 0;
  for (let position = 0; position < ringBytes; position += 8)
    for (let free = 0; free <= ringBytes; free += 8)
      for (let payloadBytes = 0; payloadBytes <= 3 * ringBytes; payloadBytes++) {
        const { writer, result } = start(position, free, payloadBytes);
        if (result._tag !== "full") continue;
        const context = { position, free, payloadBytes, needBytes: result.needBytes };
        expect(result.needBytes, JSON.stringify(context)).toBeGreaterThan(writer.freeBytes());
        expect(result.needBytes, JSON.stringify(context)).toBeLessThanOrEqual(ringBytes);
        expect(probe(position, free, payloadBytes, result.needBytes), JSON.stringify(context)).toBe(true);
        expect(probe(position, free, payloadBytes, result.needBytes - 8), JSON.stringify(context)).toBe(false);
        probes++;
      }
  expect(probes).toBeGreaterThan(1000);
});
test("rejects ring counters that claim more than the ring holds", () => {
  const ringBytes = 64;
  const layout = transportLayout({ slotBytes: 8, ringBytes });
  for (let position = 0; position < ringBytes; position += 8)
    for (let offset = -ringBytes; offset <= ringBytes; offset++)
      for (const payloadBytes of [0, 5, 8, 40, 200]) {
        const views = transportViews(new SharedArrayBuffer(layout.totalBytes), layout);
        const write = position + ringBytes;
        Atomics.store(views.words, Word.ringWrite, write);
        // A ringRead past ringWrite makes the unsigned used count exceed the ring.
        Atomics.store(views.words, Word.ringRead, write + offset);
        const writer = new RingWriter(views, layout);
        const reader = new RingReader(views, layout);
        if (offset > 0) {
          expect(() => writer.write(record(payloadBytes))).toThrow("Invalid ring counters");
          expect(() => reader.next()).toThrow("Invalid ring counters");
        } else expect(() => writer.write(record(payloadBytes))).not.toThrow();
      }
});
test("can yield before padding or a short tail and resume without losing a record", () => {
  for (const start of [40, 56]) {
    const { writer, reader, views } = setup(start);
    const input = record(24);
    expect(writer.write(input)._tag).toBe("written");
    expect(reader.next(() => false)).toBeUndefined();
    expect(Atomics.load(views.words, Word.ringRead)).toBe(start);
    let units = 0;
    expect(reader.next(() => units++ < 1)).toBeUndefined();
    expect(Atomics.load(views.words, Word.ringRead)).toBe(64);
    expect(reader.next()).toEqual(input);
    expect(reader.next()).toBeUndefined();
  }
});
test("bounded reads retain fragment identity and payload across repeated yields", () => {
  const { writer, reader, views } = setup();
  const input = record(170);
  while (writer.write(input)._tag === "full") {
    const before = Atomics.load(views.words, Word.ringRead);
    expect(reader.next(() => false)).toBeUndefined();
    expect(Atomics.load(views.words, Word.ringRead)).toBe(before);
    let units = 0;
    expect(reader.next(() => units++ < 1)).toBeUndefined();
  }
  expect(reader.next(() => false)).toBeUndefined();
  expect(reader.next()).toEqual(input);
  expect(reader.next()).toBeUndefined();
});
