// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import { RingWriter, transportLayout, transportViews, Word } from "@ibus-web/protocol/transport";
import { writeHostRecord } from "../../src/worker/output.ts";

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
