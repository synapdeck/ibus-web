// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The entry point of a worker_threads Worker that runs code written for a
// browser's dedicated Worker: it provides self, postMessage, onmessage and a
// Worker class shaped like the browser's, then imports workerData.entry.

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

// The part of a browser Worker that worker code here uses.
export class BrowserWorker {
  onmessage: MessageHandler = null;
  onerror: ((event: { message: string }) => void) | null = null;
  readonly #worker: NodeWorker;

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
  }

  postMessage(message: unknown, transfer?: readonly TransferListItem[]): void {
    this.#worker.postMessage(message, transfer);
  }

  terminate(): void {
    void this.#worker.terminate();
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
  port.on("message", (data: unknown) =>
    (scope.onmessage as MessageHandler | undefined)?.({ data }),
  );
  await import((workerData as AdapterData).entry);
}
