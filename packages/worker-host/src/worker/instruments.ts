// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Where a test build observes and steers the host. The host as released
// never provides this service, so it runs with the default, which does
// nothing and answers no request itself.

import { Context } from "effect";
import type { RuntimeHandle } from "./runtime.ts";

export interface InstrumentReply {
  ret: number;
  bytes?: Uint8Array;
}

export interface Instruments {
  // Before the runtime's module is imported, which under Node replaces the
  // global Worker class.
  readonly beforeRuntime: () => void;
  readonly runtimeStarted: (runtime: RuntimeHandle) => void;
  // Answers a request itself, or undefined to have the runtime dispatch it.
  // A promise has the host leave its request loop until it settles.
  readonly serve: (request: Uint8Array) => InstrumentReply | Promise<InstrumentReply> | undefined;
  // whileAsleep: the request arrived while the host slept, rather than
  // before it started a wait.
  readonly requestServed: (whileAsleep: boolean) => void;
  // The host left its request loop for its event loop.
  readonly eventLoopTurn: () => void;
  readonly topUpsHeld: () => boolean;
  readonly toppedUp: (workers: number, ms: number, createMs: number) => void;
}

const none: Instruments = {
  beforeRuntime: () => {},
  runtimeStarted: () => {},
  serve: () => undefined,
  requestServed: () => {},
  eventLoopTurn: () => {},
  topUpsHeld: () => false,
  toppedUp: () => {},
};

export const Instruments: Context.Reference<Instruments> = Context.Reference<Instruments>(
  "@ibus-web/worker-host/Instruments",
  { defaultValue: () => none },
);
