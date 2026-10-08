// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "@effect/vitest";
import { transportLayout, transportViews, Word } from "../../src/index.ts";
test("lays out the default shared buffer", () => {
  const layout = transportLayout();
  expect(layout).toEqual({
    slotBytes: 65536,
    ringBytes: 262144,
    totalBytes: 327744,
    slotOffset: 64,
    ringOffset: 65600,
  });
  const views = transportViews(new SharedArrayBuffer(layout.totalBytes), layout);
  expect(views.words.length).toBe(16);
  expect(views.slot.length).toBe(65536);
  expect(views.ring.length).toBe(262144);
  expect(new Set(Object.values(Word)).size).toBe(Object.keys(Word).length);
  expect(Math.max(...Object.values(Word))).toBeLessThan(16);
});
test("rejects invalid sizes and buffers", () => {
  for (const ringBytes of [0, 32, 65, 192, 2 ** 32]) expect(() => transportLayout({ ringBytes })).toThrow();
  for (const slotBytes of [0, 7, -8, NaN, Infinity]) expect(() => transportLayout({ slotBytes })).toThrow();
  const layout = transportLayout();
  expect(() => transportViews(new SharedArrayBuffer(64), layout)).toThrow();
});
