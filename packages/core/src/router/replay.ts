// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
export interface PreeditAttribute {
  readonly type: number;
  readonly value: number;
  readonly start: number;
  readonly end: number;
}

export interface Preedit {
  readonly text: string;
  readonly cursor: number;
  readonly attributes: readonly PreeditAttribute[];
}

export interface SurfaceAdapter {
  readonly element: HTMLElement;
  capabilities(): { preedit: boolean; auxText: boolean; lookupTable: boolean; surroundingText: boolean };
  contentType(): { purpose: number; hints: number; disabled: boolean };
  surrounding(window: number): { text: string; cursor: number; anchor: number } | undefined;
  caretRect(): DOMRect | undefined;
  batch(apply: () => void): void;
  commit(text: string): void;
  deleteSurrounding(offset: number, count: number): void;
  setPreedit(preedit: Preedit | undefined): void;
  replayKey(event: KeyboardEvent): void;
  forwardKey(key: { keyval: number; keycode: number; state: number }): void;
  onReset(listener: () => void): () => void;
}

/**
 * consumed: reply records applied; replayed: declined key already applied once.
 * passthrough: excluded, never intercepted/replayed; cancelled: owner detached/disposed.
 * Never replay a `replayed` result.
 */
export type AsyncKeyResult = "consumed" | "replayed" | "passthrough" | "cancelled";
export type KeyResult = "consumed" | "passthrough";
export interface KeySink {
  key(event: KeyboardEvent): KeyResult;
}

/** Includes the abandoned/in-flight key in the retained-event bound. */
export class ReplayQueue<A> {
  private readonly events: A[] = [];
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  get size(): number {
    return this.events.length;
  }
  push(event: A): void {
    this.events.push(event);
  }
  shift(): A | undefined {
    return this.events.shift();
  }
  take(): A[] {
    return this.events.splice(0);
  }
  remove(predicate: (event: A) => boolean): void {
    for (let i = this.events.length - 1; i >= 0; i--) if (predicate(this.events[i]!)) this.events.splice(i, 1);
  }
}
