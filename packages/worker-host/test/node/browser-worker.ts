// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A worker_threads Worker shaped like a browser's dedicated Worker, running
// a script written for one through the adapter.

import { Worker as NodeWorker, type TransferListItem } from "node:worker_threads";

export interface AdapterData {
  entry: string;
}

// Every Worker started under this one, Emscripten's included, inherits the
// options its parent started with, so each loads this first too.
const capture = new URL("./capture.ts", import.meta.url).href;

type Listener = (event: { data?: unknown; message?: string }) => void;

// The part of a browser Worker the host and the tests use. A Worker that
// ends without terminate() is reported as an error, as a browser would
// report the error that ended it.
export class BrowserWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  readonly #worker: NodeWorker;
  #terminated = false;

  constructor(url: string | URL) {
    const data: AdapterData = { entry: String(url) };
    this.#worker = new NodeWorker(new URL("./adapter.ts", import.meta.url), {
      workerData: data,
      execArgv: [...process.execArgv, "--import", capture],
    });
    this.#worker.on("message", (message: unknown) => this.onmessage?.({ data: message }));
    this.#worker.on("error", (error: unknown) => this.onerror?.({ message: String(error) }));
    this.#worker.on("exit", (code: number) => {
      if (!this.#terminated) this.onerror?.({ message: `exited with code ${code}` });
    });
  }

  addEventListener(type: "message" | "error", listener: Listener): void {
    if (type === "message") this.#worker.on("message", (message: unknown) => listener({ data: message }));
    else {
      this.#worker.on("error", (error: unknown) => listener({ message: String(error) }));
      this.#worker.on("exit", (code: number) => {
        if (!this.#terminated) listener({ message: `exited with code ${code}` });
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
