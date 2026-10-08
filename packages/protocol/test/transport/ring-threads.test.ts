// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Worker } from "node:worker_threads";
import { describe, expect, test } from "@effect/vitest";
import { RingReader, transportLayout, transportViews, Word } from "../../src/index.ts";
import { payloadSizes, record, WriterStatus, type WriterData } from "./support.ts";

const count = 20_000;
// Generous for a loaded builder; each case normally takes well under a second.
const deadlineMs = 60_000;

describe.each([
  [64, 0xfffff000, 1],
  [128, 0xffffffc8, 2],
  [256, 0xfffffff8, 3],
  [1024, 0x7ffffff0, 4],
  [64, 0, 5],
] as const)("a %i-byte ring shared with a writer thread from counter %i", (ringBytes, start, seed) => {
  test(
    "delivers every record in order through the full-ring wait",
    async () => {
      const layout = transportLayout({ slotBytes: 8, ringBytes });
      const buffer = new SharedArrayBuffer(layout.totalBytes);
      const views = transportViews(buffer, layout);
      Atomics.store(views.words, Word.ringRead, start | 0);
      Atomics.store(views.words, Word.ringWrite, start | 0);
      const status = new Int32Array(new SharedArrayBuffer(4));
      const workerData: WriterData = {
        buffer,
        layout,
        status: status.buffer as SharedArrayBuffer,
        seed,
        count,
        waitMs: deadlineMs / 2,
      };
      const worker = new Worker(new URL("./ring-writer.worker.ts", import.meta.url), { workerData });
      try {
        const reader = new RingReader(views, layout);
        const sizes = payloadSizes(seed, ringBytes, count);
        const deadline = Date.now() + deadlineMs;
        let received = 0;
        // The reader blocks this thread, so it polls the writer's status and its own deadline itself.
        while (received < count) {
          const next = reader.next();
          if (next) {
            const expected = record(sizes[received]!, received + 1);
            // Deep equality on every byte of thousands of records would dominate the run time.
            if (!Buffer.from(next).equals(Buffer.from(expected))) expect(next).toEqual(expected);
            received++;
            continue;
          }
          const writerStatus = Atomics.load(status, 0);
          if (writerStatus !== WriterStatus.running && writerStatus !== WriterStatus.done)
            throw new Error(`Writer stopped with status ${writerStatus} after ${received} records`);
          if (Date.now() > deadline) throw new Error(`Timed out after ${received} records`);
          Atomics.wait(views.words, Word.ringWrite, Atomics.load(views.words, Word.ringRead), 10);
        }
        expect(reader.next()).toBeUndefined();
        Atomics.wait(status, 0, WriterStatus.running, deadlineMs);
        expect(Atomics.load(status, 0)).toBe(WriterStatus.done);
      } finally {
        await worker.terminate();
      }
    },
    deadlineMs * 2,
  );
});
