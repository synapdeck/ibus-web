// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// How a page starts the host with HostWorker, type-checked so the
// declaration stays usable that way.

import type { HostInit, HostMessage } from "../dist/shared/index.js";
import type { HostWorker } from "./worker.js";

export const start = (
  url: URL,
  init: HostInit<WebAssembly.Module>,
  received: (message: HostMessage) => void,
): HostWorker => {
  const worker = new Worker(url, { type: "module" }) as HostWorker;
  worker.addEventListener("message", ({ data }) => received(data));
  worker.postMessage(init);
  return worker;
};
