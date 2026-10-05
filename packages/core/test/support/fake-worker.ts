// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { encodeValue, RingWriter, recordKinds } from "@ibus-web/protocol";
import {
  controlViews,
  postReply,
  postCrash,
  ReqMode,
  State,
  Word,
  transportLayout,
  type HostInit,
  type HostMessage,
  type ControlViews,
} from "@ibus-web/worker-host";

export function record(
  seq: number,
  ic = 1,
  tag = "HidePreeditText",
  signature = "()",
  value: (number | string)[] = [],
) {
  const payload = encodeValue(signature, {
    _tag: "()",
    items: value.map((value) => (typeof value === "number" ? { _tag: "u", value } : { _tag: "s", value })),
  });
  const bytes = new Uint8Array(Math.ceil((16 + payload.length) / 8) * 8);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, seq, true);
  header.setUint32(4, ic, true);
  header.setUint16(8, recordKinds.get(tag)!, true);
  header.setUint32(12, payload.length, true);
  bytes.set(payload, 16);
  return bytes;
}
export interface Script {
  after?: number | "never";
  records?: Uint8Array[];
  ret?: number;
  // Adversarial publication lets the page prove it observes replyOutSeq.
  recordsAfterReply?: number;
}
export class FakeWorker extends EventTarget {
  init!: HostInit;
  views!: ControlViews;
  writer!: RingWriter;
  now = 0;
  terminated = false;
  requests: Uint8Array[] = [];
  scripts: Script[] = [];
  onTick: (() => void) | undefined;
  private active: { script: Script; due: number; records: Uint8Array[]; replied: boolean } | undefined;
  private seq = 0;
  private bells = 0;
  asWorker(): Worker {
    return this as unknown as Worker;
  }
  postMessage(init: HostInit) {
    this.init = init;
    const layout = init.layout ?? transportLayout();
    this.views = controlViews(init.control, layout);
    this.writer = new RingWriter(this.views, layout);
    this.message({ type: "ready", startupMs: 0 });
  }
  message(data: HostMessage) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  terminate() {
    this.terminated = true;
  }
  ring() {
    if (Atomics.exchange(this.views.words, Word.doorbell, 1) === 0) this.bells++;
  }
  deliver() {
    while (this.bells > 0) {
      this.bells--;
      this.message({ type: "doorbell" });
    }
  }
  write(bytes: Uint8Array): boolean {
    if (this.writer.write(bytes)._tag === "full") {
      Atomics.store(this.views.words, Word.ringWaiting, 1);
      this.ring();
      return false;
    }
    const seq = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
    if (seq !== 0) this.seq = seq;
    return true;
  }
  tick = (): number => {
    this.now++;
    this.onTick?.();
    if (this.terminated || !this.views) return this.now;
    if (!this.active && Atomics.load(this.views.words, Word.state) === State.request) {
      this.requests.push(this.views.slot.slice(0, Atomics.load(this.views.words, Word.reqLen)));
      const script = this.scripts.shift() ?? {};
      this.active = {
        script,
        due: script.after === "never" ? Infinity : this.now + (script.after ?? 0),
        records: [...(script.records ?? [])],
        replied: false,
      };
    }
    const active = this.active;
    if (!active || this.now < active.due) return this.now;
    if (active.script.recordsAfterReply !== undefined && !active.replied) {
      const last = active.records.at(-1);
      postReply(
        this.views,
        active.script.ret ?? 1,
        last ? new DataView(last.buffer, last.byteOffset).getUint32(0, true) : this.seq,
      );
      active.replied = true;
      this.ring();
      active.due = this.now + active.script.recordsAfterReply;
      return this.now;
    }
    while (active.records.length > 0) {
      if (!this.write(active.records[0]!)) return this.now;
      active.records.shift();
    }
    if (!active.replied) postReply(this.views, active.script.ret ?? 1, this.seq);
    if (Atomics.load(this.views.words, Word.reqMode) !== ReqMode.sync || active.replied) this.ring();
    this.active = undefined;
    return this.now;
  };
  crash() {
    postCrash(this.views);
    this.ring();
  }
}
