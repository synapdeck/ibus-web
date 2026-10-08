// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The host's test build: the host as released, with the instruments, the
// limits HostInit.test shortens, and on request a relay that fails.

import { Effect } from "effect";
import type { HostInit } from "../../src/shared/messages.ts";
import { defaultHostConfig, HostConfig } from "../../src/worker/config.ts";
import { program } from "../../src/worker/host.ts";
import type { WorkerEnv } from "../../src/worker/layers/worker.ts";
import { Instruments } from "../../src/worker/instruments.ts";
import type { TestInit } from "../shared/testing.ts";
import { makeInstruments } from "./instruments.ts";

self.onmessage = ({ data }: MessageEvent<HostInit<WebAssembly.Module, TestInit>>) => {
  self.onmessage = null;
  const test: TestInit = data.test ?? { mallinfo: { bytes: 0, inUseOffset: 0 } };
  const config = { ...defaultHostConfig, ...test.config };
  const env: WorkerEnv = {
    post: (message) => self.postMessage(message),
    onUncaughtError: (listener) => self.addEventListener("error", listener),
    relayUrl:
      test.relayFailsAfter === undefined
        ? new URL("../../worker/relay.js", import.meta.url)
        : new URL(`./failing-relay.js?after=${test.relayFailsAfter}`, import.meta.url),
  };
  Effect.runFork(
    program(data, env).pipe(
      Effect.provide(HostConfig.layerWith(config)),
      Effect.provideService(
        Instruments,
        makeInstruments(test, config, data.control, (message) => self.postMessage(message)),
      ),
    ),
  );
};
