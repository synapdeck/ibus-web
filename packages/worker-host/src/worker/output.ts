// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { State, Word, type ControlViews } from "../shared/control.ts";
import type { RingWriter } from "@ibus-web/protocol/transport";
import { CrashReason } from "@ibus-web/protocol";
import { RuntimeStopped } from "./failure.ts";
import type { Runtime } from "./runtime.ts";

export class HostDefect extends Error {}

export interface OutputWaitContext {
  readonly control: ControlViews;
  readonly handle: { readonly words: Int32Array };
  readonly wakeIndex: number;
  readonly constants: { readonly waitTimedOut: number };
  readonly postDoorbell: () => void;
}

const requireLiveRelay = (control: ControlViews): void => {
  if (Atomics.load(control.words, Word.state) === State.crashed)
    throw new RuntimeStopped({ error: "relay failed during output drain", reason: CrashReason.relay });
};

// A wake may arrive before the runtime starts sleeping. Read its word after
// ringing, then check space again so a page read cannot be lost in that gap.
const waitForSpace = (rt: Runtime, writer: RingWriter, needBytes: number, ctx: OutputWaitContext): void => {
  Atomics.store(ctx.control.words, Word.ringWaiting, 1);
  if (Atomics.exchange(ctx.control.words, Word.doorbell, 1) === 0) ctx.postDoorbell();
  const seen = Atomics.load(ctx.handle.words, ctx.wakeIndex);
  const free = writer.freeBytes();
  requireLiveRelay(ctx.control);
  if (free >= needBytes) return;
  const ret = rt._ibusweb_wait(seen, -1);
  if (ret < 0 && ret !== ctx.constants.waitTimedOut) throw new Error(`ibusweb_wait: ${ret}`);
  requireLiveRelay(ctx.control);
};

// Keep the copied frame unchanged until its final fragment is published.
// Only the wait runs under back-pressure, so no pump can interleave records.
export const drainOutput = (rt: Runtime, writer: RingWriter, words: Int32Array, ctx: OutputWaitContext): number => {
  const pointer = rt._ibusweb_output_peek(words.byteOffset);
  const length = words[0]! >>> 0;
  let copied = 0;
  let count = 0;
  while (copied < length) {
    if (length - copied < 16) throw new HostDefect("truncated runtime output header");
    const header = new DataView(rt.HEAPU8.buffer, pointer + copied, 16);
    const size = Math.ceil((16 + header.getUint32(12, true)) / 8) * 8;
    if (size > length - copied) throw new HostDefect("truncated runtime output record");
    const record = rt.HEAPU8.slice(pointer + copied, pointer + copied + size);
    let result = writer.write(record);
    while (result._tag === "full") {
      waitForSpace(rt, writer, result.needBytes, ctx);
      result = writer.write(record);
    }
    Atomics.store(ctx.control.words, Word.ringWaiting, 0);
    copied += size;
    count++;
  }
  // A trap leaves the runtime unfit for calls, including consume. Leave its
  // output untouched unless every frame in this batch was published.
  if (copied > 0) rt._ibusweb_output_consume(copied);
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
