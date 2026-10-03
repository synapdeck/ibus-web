// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The entry point of a worker_threads Worker that runs code written for a
// browser's dedicated Worker: it provides self, postMessage, onmessage,
// error events and a Worker class shaped like the browser's, then imports
// workerData.entry. Node runs it from source.

import process from "node:process";
import { parentPort, type TransferListItem, workerData } from "node:worker_threads";
import { BrowserWorker, type AdapterData } from "./browser-worker.ts";

const port = parentPort!;
const scope = globalThis as unknown as Record<string, unknown>;
scope.self = globalThis;
scope.Worker = BrowserWorker;
scope.postMessage = (message: unknown, transfer?: readonly TransferListItem[]) => port.postMessage(message, transfer);

// A browser holds messages for a Worker until its script has set a handler,
// which a module does only once it has loaded.
type MessageHandler = ((event: { data: unknown }) => void) | null;
const queued: unknown[] = [];
let handler: MessageHandler = null;
const deliver = (): void => {
  while (handler !== null && queued.length > 0) handler({ data: queued.shift() });
};
Object.defineProperty(scope, "onmessage", {
  configurable: true,
  get: () => handler,
  set: (value: MessageHandler) => {
    handler = value;
    setImmediate(deliver);
  },
});
port.on("message", (data: unknown) => {
  queued.push(data);
  deliver();
});

// A browser dispatches an uncaught error to the Worker's "error" listeners;
// one that none of them prevents goes on to the Worker's owner, which here
// means the Worker ends with it.
interface ErrorEventLike {
  message: string;
  error: unknown;
  preventDefault(): void;
}
const errorListeners = new Set<(event: ErrorEventLike) => void>();
const dispatchError = (error: unknown): void => {
  let prevented = false;
  const event = {
    message: String(error),
    error,
    preventDefault: () => {
      prevented = true;
    },
  };
  for (const listener of errorListeners) listener(event);
  if (!prevented) {
    process.off("uncaughtException", dispatchError);
    throw error;
  }
};
scope.addEventListener = (type: string, listener: (event: ErrorEventLike) => void) => {
  if (type !== "error") throw new Error(`no ${type} events here`);
  if (errorListeners.size === 0) process.on("uncaughtException", dispatchError);
  errorListeners.add(listener);
};

await import((workerData as AdapterData).entry);
