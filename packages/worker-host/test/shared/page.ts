// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { decodeRecord, RingReader, transportLayout, type DecodedRecord } from "@ibus-web/protocol";
import { controlViews, postRequest, takeReply, ReqMode, State, Word, type Reply } from "../../src/shared/control.ts";
import type { Clock } from "./client.ts";

export class Page {
  readonly views;
  private readonly reader: RingReader;
  private readonly received: DecodedRecord[] = [];
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private replyReady: (() => void) | undefined;
  constructor(control: SharedArrayBuffer, clock: Clock, timeoutMs: number) {
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.views = controlViews(control);
    this.reader = new RingReader(this.views, transportLayout());
  }
  post(bytes: Uint8Array, mode: number): void {
    postRequest(this.views, bytes, mode);
  }
  request(kind: number, ic: number, payload: Uint8Array = new Uint8Array(), mode: number = ReqMode.sync): void {
    const bytes = new Uint8Array(8 + payload.length);
    const header = new DataView(bytes.buffer);
    header.setUint16(0, kind, true);
    header.setUint32(4, ic, true);
    bytes.set(payload, 8);
    this.post(bytes, mode);
  }
  private drain(): void {
    for (let bytes = this.reader.next(); bytes !== undefined; bytes = this.reader.next())
      this.received.push(decodeRecord(bytes));
  }
  records(): DecodedRecord[] {
    this.drain();
    return this.received.splice(0);
  }
  onDoorbell(): void {
    Atomics.store(this.views.words, Word.doorbell, 0);
    this.drain();
    this.replyReady?.();
  }
  onCrash(): void {
    this.replyReady?.();
  }
  takeReply(): Reply {
    this.drain();
    return takeReply(this.views);
  }
  abandon(): Reply | undefined {
    Atomics.compareExchange(this.views.words, Word.reqMode, ReqMode.sync, ReqMode.abandoned);
    return Atomics.load(this.views.words, Word.state) === State.reply ? this.takeReply() : undefined;
  }
  async waitForReply(): Promise<Reply> {
    const deadline = this.clock.now() + this.timeoutMs;
    for (;;) {
      const state = Atomics.load(this.views.words, Word.state);
      if (state === State.reply) return this.takeReply();
      if (state === State.crashed) throw new Error("the host crashed");
      if (this.clock.now() >= deadline) throw new Error("no reply before the page's deadline");
      if (Atomics.load(this.views.words, Word.reqMode) !== ReqMode.sync) {
        return new Promise<Reply>((resolve, reject) => {
          const finish = (result: Reply | Error): void => {
            cancelDeadline();
            this.replyReady = undefined;
            if (result instanceof Error) reject(result);
            else resolve(result);
          };
          const cancelDeadline = this.clock.schedule(deadline - this.clock.now(), () =>
            finish(new Error("no completion doorbell before the page's deadline")),
          );
          this.replyReady = () => {
            try {
              const current = Atomics.load(this.views.words, Word.state);
              if (current === State.reply) finish(this.takeReply());
              else if (current === State.crashed) finish(new Error("the host crashed"));
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)));
            }
          };
          // Recheck after installing the waiter, including replies that landed
          // just before the page abandoned its synchronous wait.
          this.replyReady();
        });
      }
      await this.clock.sleep(1);
    }
  }
}
