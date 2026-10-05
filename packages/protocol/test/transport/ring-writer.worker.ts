// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { workerData } from "node:worker_threads";
import { RingWriter } from "../../src/transport/ring.ts";
import { transportViews, Word } from "../../src/transport/layout.ts";
import { payloadSizes, record, WriterStatus, type WriterData } from "./support.ts";

const data = workerData as WriterData;
const status = new Int32Array(data.status);
const finish = (value: number) => {
  Atomics.store(status, 0, value);
  Atomics.notify(status, 0);
};
const views = transportViews(data.buffer, data.layout);
const writer = new RingWriter(views, data.layout);
try {
  for (const [index, size] of payloadSizes(data.seed, data.layout.ringBytes, data.count).entries()) {
    const input = record(size, index + 1);
    for (let result = writer.write(input); result._tag === "full"; result = writer.write(input)) {
      // The reader here sleeps on ringWrite; a page would drain on doorbells instead.
      Atomics.notify(views.words, Word.ringWrite);
      // The host's full-ring wait: announce it, take the wake value, then re-check. A read between
      // the announcement and the sample clears ringWaiting and spends its wake inside `seen`, and
      // later reads won't wake anyone, so a cleared ringWaiting means announcing again.
      Atomics.store(views.words, Word.ringWaiting, 1);
      const seen = Atomics.load(views.words, Word.wake);
      if (writer.freeBytes() >= result.needBytes || Atomics.load(views.words, Word.ringWaiting) === 0) continue;
      if (Atomics.wait(views.words, Word.wake, seen, data.waitMs) === "timed-out") {
        finish(WriterStatus.wakeLost);
        process.exit(0);
      }
    }
    Atomics.notify(views.words, Word.ringWrite);
  }
  finish(WriterStatus.done);
} catch (error) {
  console.error(error);
  finish(WriterStatus.failed);
}
