// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { RingReader, RingWriter, transportLayout, transportViews, Word } from "../../src/index.ts";
import { counterStarts, published, record, ringSizes } from "./support.ts";

const steps = Schema.Array(
  Schema.Struct({
    // Raw sizes are folded into 0–7 bytes or up to three rings once the ring size is known.
    small: Schema.Boolean,
    size: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 * 1024 })),
    readAfter: Schema.Boolean,
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(40));

describe.each(ringSizes.flatMap((ringBytes) => counterStarts.map((start) => [ringBytes, start] as const)))(
  "a %i-byte ring from counter %i",
  (ringBytes, start) => {
    it.prop(
      "delivers every record once and progresses whenever needBytes is free",
      [steps],
      ([plan]) => {
        const layout = transportLayout({ slotBytes: 8, ringBytes });
        const views = transportViews(new SharedArrayBuffer(layout.totalBytes), layout);
        Atomics.store(views.words, Word.ringRead, start | 0);
        Atomics.store(views.words, Word.ringWrite, start | 0);
        const writer = new RingWriter(views, layout);
        const reader = new RingReader(views, layout);
        const expected: Uint8Array[] = [];
        const actual: Uint8Array[] = [];
        const read = () => {
          const next = reader.next();
          if (next) actual.push(next);
        };
        for (const [index, step] of plan.entries()) {
          const input = record(step.small ? step.size % 8 : step.size % (3 * ringBytes + 1), index + 1);
          expected.push(input);
          let before = Atomics.load(views.words, Word.ringWrite);
          let result = writer.write(input);
          published(views, before, Atomics.load(views.words, Word.ringWrite));
          while (result._tag === "full") {
            expect(result.needBytes).toBeLessThanOrEqual(ringBytes);
            // Free exactly what needBytes asks for; the next write must then publish a fragment.
            while (writer.freeBytes() < result.needBytes) read();
            before = Atomics.load(views.words, Word.ringWrite);
            result = writer.write(input);
            expect(published(views, before, Atomics.load(views.words, Word.ringWrite)).fragments).toBeGreaterThan(0);
          }
          if (step.readAfter) read();
        }
        for (let next = reader.next(); next; next = reader.next()) actual.push(next);
        expect(actual).toEqual(expected);
      },
      { arbitrary: { runs: 40, seed: 1303 } },
    );
  },
);
