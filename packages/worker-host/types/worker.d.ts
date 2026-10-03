// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The host's Worker script exports nothing. A page starts it by URL as a
// module Worker, posts it one HostInit and then receives HostMessages; a
// HostWorker is such a Worker, typed for that exchange.

import type { HostInit, HostMessage } from "../dist/shared/index.js";

export interface HostWorker extends Worker {
  postMessage(message: HostInit<WebAssembly.Module>, transfer: Transferable[]): void;
  postMessage(message: HostInit<WebAssembly.Module>, options?: StructuredSerializeOptions): void;
  addEventListener(
    type: "message",
    listener: (this: Worker, event: MessageEvent<HostMessage>) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
}
