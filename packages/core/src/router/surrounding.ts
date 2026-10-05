// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { IBusText } from "@ibus-web/protocol";
export type Surrounding = { text: string; cursor: number; anchor: number };
export const ibusText = (text: string): IBusText => ({
  attachments: {},
  text,
  attrs: { attachments: {}, attributes: [] },
});
export const toCodePoints = (text: string, units: number): number =>
  Array.from(text.slice(0, Math.max(0, units))).length;
export const toUtf16 = (text: string, points: number): number =>
  [...text].slice(0, Math.max(0, points)).join("").length;
export function surroundingWindow(value: Surrounding, radius: number): Surrounding {
  const points = [...value.text];
  const cursor = toCodePoints(value.text, value.cursor),
    anchor = toCodePoints(value.text, value.anchor);
  const start = Math.max(0, cursor - radius),
    end = Math.min(points.length, cursor + radius);
  return {
    text: points.slice(start, end).join(""),
    cursor: cursor - start,
    anchor: Math.max(0, Math.min(end - start, anchor - start)),
  };
}
export function deletion(value: Surrounding, offset: number, count: number): { offset: number; count: number } {
  const cursor = toCodePoints(value.text, value.cursor);
  const start = toUtf16(value.text, Math.max(0, cursor + offset));
  const end = toUtf16(value.text, Math.max(0, cursor + offset + count));
  return { offset: start - value.cursor, count: Math.max(0, end - start) };
}
