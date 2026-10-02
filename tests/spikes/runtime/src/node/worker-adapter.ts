// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The entry point of a worker_threads Worker that runs code written for a
// browser's dedicated Worker: it provides self, postMessage, onmessage and a
// Worker class shaped like the browser's, then imports workerData.entry.

import process from "node:process";
import {
  parentPort,
  type TransferListItem,
  Worker as NodeWorker,
  workerData,
} from "node:worker_threads";

export interface AdapterData {
  entry: string;
}

type MessageHandler = ((event: { data: unknown }) => void) | null;
type ErrorHandler = (event: { message: string }) => void;

// The part of a browser Worker that worker code here uses. A Worker that
// ends without terminate() is reported as an error, as a browser would
// report the error that ended it.
export class BrowserWorker {
  onmessage: MessageHandler = null;
  onerror: ErrorHandler | null = null;
  readonly #worker: NodeWorker;
  #terminated = false;

  constructor(url: string | URL) {
    const data: AdapterData = { entry: String(url) };
    this.#worker = new NodeWorker(new URL(import.meta.url), {
      workerData: data,
    });
    this.#worker.on("message", (message: unknown) =>
      this.onmessage?.({ data: message }),
    );
    this.#worker.on("error", (error: unknown) =>
      this.onerror?.({ message: String(error) }),
    );
    this.#worker.on("exit", (code: number) => {
      if (!this.#terminated)
        this.onerror?.({ message: `exited with code ${code}` });
    });
  }

  addEventListener(
    type: "message" | "error",
    listener: (event: { data?: unknown; message?: string }) => void,
  ): void {
    if (type === "message")
      this.#worker.on("message", (message: unknown) =>
        listener({ data: message }),
      );
    else {
      this.#worker.on("error", (error: unknown) =>
        listener({ message: String(error) }),
      );
      this.#worker.on("exit", (code: number) => {
        if (!this.#terminated)
          listener({ message: `exited with code ${code}` });
      });
    }
  }

  postMessage(message: unknown, transfer?: readonly TransferListItem[]): void {
    this.#worker.postMessage(message, transfer);
  }

  // Settles once the Worker has stopped, which a browser's terminate()
  // doesn't wait for.
  async terminate(): Promise<void> {
    this.#terminated = true;
    await this.#worker.terminate();
  }
}

// Only when run as a Worker's entry point; importing it for BrowserWorker
// does nothing else.
if (parentPort !== null) {
  const port = parentPort;
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.self = globalThis;
  scope.Worker = BrowserWorker;
  scope.postMessage = (
    message: unknown,
    transfer?: readonly TransferListItem[],
  ) => port.postMessage(message, transfer);

  // A browser holds messages for a Worker until its script has set a
  // handler, which a module does only once it has loaded.
  const queued: unknown[] = [];
  let handler: MessageHandler = null;
  const deliver = (): void => {
    while (handler !== null && queued.length > 0)
      handler({ data: queued.shift() });
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

  // A browser dispatches an uncaught error to the Worker's "error"
  // listeners instead of ending it; without any, Node's own handling stays.
  type ErrorListener = (event: {
    message: string;
    error: unknown;
    preventDefault(): void;
  }) => void;
  const errorListeners = new Set<ErrorListener>();
  const dispatchError = (error: unknown): void => {
    for (const listener of errorListeners)
      listener({ message: String(error), error, preventDefault: () => {} });
  };
  scope.addEventListener = (type: string, listener: ErrorListener) => {
    if (type !== "error") throw new Error(`no ${type} events here`);
    if (errorListeners.size === 0)
      process.on("uncaughtException", dispatchError);
    errorListeners.add(listener);
  };
  scope.removeEventListener = (type: string, listener: ErrorListener) => {
    if (type !== "error" || !errorListeners.delete(listener)) return;
    if (errorListeners.size === 0)
      process.off("uncaughtException", dispatchError);
  };

  await import((workerData as AdapterData).entry);
}
