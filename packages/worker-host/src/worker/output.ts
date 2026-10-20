// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { ControlViews } from "../shared/control.ts";
import { State, Word, type RingWriter } from "@ibus-web/protocol/transport";
import { CrashReason } from "@ibus-web/protocol";
import type { Backend } from "./backend.ts";
import { RuntimeStopped } from "./failure.ts";
import { wait, type Runtime } from "./runtime.ts";

export class HostDefect extends Error {}

// A GVariant string is UTF-8 without NUL, which a JavaScript string needn't
// be. Text the host frames on a module's behalf, or for a crash, has either
// replaced with U+FFFD, since failing to frame it would lose the record.
export const recordText = (text: string): string => text.replace(/[\0\p{Cs}]/gu, "\uFFFD");

interface RingContext {
  readonly control: ControlViews;
  readonly postDoorbell: () => void;
  // The sequence number of the last module record published to the ring.
  lastSeq: number;
}

// Where the loop publishes a backend's records.
export interface OutputRing extends RingContext {
  readonly writer: RingWriter;
}

interface OutputWaitContext extends RingContext {
  readonly handle: { readonly words: Int32Array };
  readonly wakeIndex: number;
  readonly constants: { readonly waitTimedOut: number };
}

type Sleeper = Pick<Backend, "wake" | "wait">;

const requireLiveRelay = (control: ControlViews): void => {
  if (Atomics.load(control.words, Word.state) === State.crashed)
    throw new RuntimeStopped({ error: "relay failed during output drain", reason: CrashReason.relay });
};

// A wake may arrive before the backend starts sleeping. Read its word after
// ringing, then check space again so a page read cannot be lost in that gap.
const waitForSpace = (writer: RingWriter, needBytes: number, ctx: RingContext, sleeper: Sleeper): void => {
  Atomics.store(ctx.control.words, Word.ringWaiting, 1);
  if (Atomics.exchange(ctx.control.words, Word.doorbell, 1) === 0) ctx.postDoorbell();
  const seen = Atomics.load(sleeper.wake.words, sleeper.wake.index);
  const free = writer.freeBytes();
  requireLiveRelay(ctx.control);
  // A partial read can acknowledge waiting before its wake is sampled.
  // Re-arm so the remaining reads still have a waiter to notify.
  if (free >= needBytes || Atomics.load(ctx.control.words, Word.ringWaiting) === 0) return;
  sleeper.wait(seen, -1);
  requireLiveRelay(ctx.control);
};

// Writes a batch of whole records to the ring, waiting through sleeper
// while it is full, and returns how many. No pump runs during a wait, so
// nothing can interleave records. lastSeq follows the records actually
// published.
export const publishRecords = (writer: RingWriter, batch: Uint8Array, ctx: RingContext, sleeper: Sleeper): number => {
  const view = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
  let copied = 0;
  let count = 0;
  while (copied < batch.length) {
    if (batch.length - copied < 16) throw new HostDefect("truncated runtime output header");
    const size = Math.ceil((16 + view.getUint32(copied + 12, true)) / 8) * 8;
    if (size > batch.length - copied) throw new HostDefect("truncated runtime output record");
    const record = batch.subarray(copied, copied + size);
    let result = writer.write(record);
    while (result._tag === "full") {
      waitForSpace(writer, result.needBytes, ctx, sleeper);
      result = writer.write(record);
    }
    Atomics.store(ctx.control.words, Word.ringWaiting, 0);
    ctx.lastSeq = view.getUint32(copied, true);
    copied += size;
    count++;
  }
  return count;
};

// The peeked pointer is good only until the next runtime call, and a wait
// for ring space is one: a call another thread proxied to the host runs
// inside it, and one that logs appends to the output buffer, which may move.
// So the whole batch is copied before anything is written. lastSeq never
// comes from ibusweb_output_last_seq(), which can already count a record
// appended during the wait and still waiting for the next drain.
export const drainOutput = (rt: Runtime, writer: RingWriter, words: Int32Array, ctx: OutputWaitContext): number => {
  const pointer = rt._ibusweb_output_peek(words.byteOffset);
  const batch = rt.HEAPU8.slice(pointer, pointer + (words[0]! >>> 0));
  const count = publishRecords(writer, batch, ctx, {
    wake: { words: ctx.handle.words, index: ctx.wakeIndex },
    wait: (seen, timeoutMs) => wait(rt, ctx.constants, seen, timeoutMs),
  });

  // A trap leaves the runtime unfit for calls, including consume. Leave its
  // output untouched unless every frame in this batch was published.
  if (batch.length > 0) rt._ibusweb_output_consume(batch.length);
  return count;
};

// Host records use zero sequence and input context, so they never advance
// the runtime's reply watermark. A full ring must not delay crash reporting.
export const writeHostRecord = (
  writer: RingWriter,
  control: ControlViews,
  kind: number,
  payload: Uint8Array,
): boolean => {
  const record = new Uint8Array(Math.ceil((16 + payload.length) / 8) * 8);
  const header = new DataView(record.buffer);
  header.setUint16(8, kind, true);
  header.setUint32(12, payload.length, true);
  record.set(payload, 16);
  try {
    const position = (Atomics.load(control.words, Word.ringWrite) >>> 0) % control.ring.length;
    const tail = control.ring.length - position;
    const required = record.length <= tail ? record.length : tail + record.length;
    if (writer.freeBytes() < required) return false;
    return writer.write(record)._tag !== "full";
  } catch {
    return false;
  }
};
