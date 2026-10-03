// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Starting a Worker host: its one message, then its "ready" or why it
// didn't start.

import type { HostInit } from "../../src/shared/messages.ts";
import type { Message } from "./testing.ts";

// A Worker's message or error event, as far as the bootstrap reads it.
export interface HostEvent {
  data?: unknown;
  message?: string;
  filename?: string;
  lineno?: number;
}

// What the bootstrap uses of a browser Worker or Node's stand-in for one.
export interface HostWorker {
  addEventListener(type: "message" | "error", listener: (event: HostEvent) => void): void;
  postMessage(message: unknown): void;
}

// Resolves with the host's startup time once it is ready; rejects if the
// host reports an error or its Worker fails before then. Every other message
// is added to messages as the caller's event loop receives it.
export const startHost = <Wasm, Test>(
  worker: HostWorker,
  init: HostInit<Wasm, Test>,
  messages: Message[],
): Promise<number> => {
  let started = false;
  const ready = new Promise<number>((resolve, reject) => {
    worker.addEventListener("message", ({ data }) => {
      const message = data as Message;
      if (message.type === "ready") {
        started = true;
        resolve(message.startupMs);
      } else if (message.type === "error" && !started) reject(new Error(`host: ${message.message}`));
      else messages.push(message);
    });
    worker.addEventListener("error", ({ message, filename, lineno }) => {
      const where = filename === undefined ? "" : ` (${filename}:${lineno})`;
      const text = `${message ?? "an error"}${where}`;
      if (started) messages.push({ type: "error", message: text });
      else reject(new Error(`host: ${text}`));
    });
  });
  worker.postMessage(init);
  return ready;
};
