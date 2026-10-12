// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The Worker host's script, which the page starts by URL. Its first message
// is a HostInit; the rest go to the host. It runs with the default
// configuration and no instruments: whatever HostInit.test holds is never
// read.

import { Effect } from "effect";
import type { HostInit } from "../shared/messages.ts";
import { HostConfig } from "./config.ts";
import { program } from "./host.ts";
import type { WorkerEnv } from "./layers/worker.ts";

const env: WorkerEnv = {
  post: (message) => self.postMessage(message),
  onUncaughtError: (listener) => self.addEventListener("error", listener),
  onMessage: (listener) => {
    self.onmessage = ({ data }: MessageEvent) => listener(data);
  },
  relayUrl: new URL("./relay.js", import.meta.url),
};

self.onmessage = ({ data }: MessageEvent<HostInit<WebAssembly.Module, unknown>>) => {
  self.onmessage = null;
  Effect.runFork(program(data, env).pipe(Effect.provide(HostConfig.layer)));
};
