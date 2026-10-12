// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The page's messages after HostInit. They arrive only through the host's
// event loop, which a host asleep in the runtime doesn't run, so the page
// counts each in the control buffer's mail word too (postMail()), and the
// host, seeing the count change, goes to its event loop to take them.

import type { PrepareEngine } from "../shared/messages.ts";

const isPrepare = (message: unknown): message is PrepareEngine =>
  typeof message === "object" &&
  message !== null &&
  (message as { type?: unknown }).type === "prepare-engine" &&
  typeof (message as { engine?: unknown }).engine === "string";

export class Mail {
  readonly #queue: (PrepareEngine | undefined)[] = [];
  #arrived: (() => void) | undefined;

  // A message the page posted. It counts in the mail word whatever it is,
  // so one the host doesn't know is kept as undefined, which it skips.
  receive(message: unknown): void {
    this.#queue.push(isPrepare(message) ? message : undefined);
    this.#arrived?.();
    this.#arrived = undefined;
  }

  // Whether a message has arrived that hasn't been taken.
  get waiting(): boolean {
    return this.#queue.length > 0;
  }

  // Settles once a message is waiting.
  async arrival(): Promise<void> {
    while (this.#queue.length === 0)
      await new Promise<void>((resolve) => {
        this.#arrived = resolve;
      });
  }

  // Takes the next message, once it has arrived.
  async next(): Promise<PrepareEngine | undefined> {
    await this.arrival();
    return this.#queue.shift()!;
  }
}
