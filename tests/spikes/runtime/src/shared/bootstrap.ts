// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Starting a Worker host: its one message, then its "ready" or why it
// didn't start.

import type { HostFeatures, HostInit, HostMessage } from "./control.ts";

// A Worker's message or error event, as far as the bootstrap reads it.
export interface HostEvent {
  data?: unknown;
  message?: string;
  filename?: string;
  lineno?: number;
}

// What the bootstrap uses of a browser Worker or Node's stand-in for one.
export interface HostWorker {
  addEventListener(
    type: "message" | "error",
    listener: (event: HostEvent) => void,
  ): void;
  postMessage(message: unknown): void;
}

export interface StartedHost {
  startupMs: number;
  features: HostFeatures;
  // The host's messages after "ready", such as a crash report, as the
  // caller's event loop receives them.
  messages: HostMessage[];
}

// Rejects if the host reports an error or its Worker fails before "ready".
export const startHost = (
  worker: HostWorker,
  init: HostInit,
): Promise<StartedHost> => {
  const messages: HostMessage[] = [];
  let started = false;
  const ready = new Promise<StartedHost>((resolve, reject) => {
    worker.addEventListener("message", ({ data }) => {
      const message = data as HostMessage;
      if (message.type === "ready") {
        started = true;
        resolve({
          startupMs: message.startupMs,
          features: message.features,
          messages,
        });
      } else if (message.type === "error")
        reject(new Error(`host: ${message.message}`));
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
