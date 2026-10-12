// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Where a test build observes and steers the host. The host as released
// never provides this service, so it runs with the default, which does
// nothing and answers no request itself.

import { Context } from "effect";
import type { RuntimeHandle } from "./runtime.ts";
import type { MountedStorage } from "./storage/mount.ts";

export interface InstrumentReply {
  ret: number;
  stop?: boolean;
  bytes?: Uint8Array;
}

export interface Instruments {
  // Before the host looks for IndexedDB.
  readonly forceBrotliFallback: boolean;
  // A Brotli archive of the engine's data is decoded through this decoder.
  readonly brotliDecoder: (decoder: "native" | "fallback") => void;
  // An archive of the engine's data is about to be fetched.
  readonly fetching: (url: string) => void;
  // The data backend's window for changes opened or shut.
  readonly window: (open: boolean) => void;
  // A staging tree an install cut short left at path was removed.
  readonly swept: (path: string) => void;
  // A store path's tree is in place and its marker about to be written; the
  // install waits for a promise.
  readonly beforeMark: (storePath: string) => Promise<void> | undefined;
  readonly beforeProbe: () => void;
  // Before the runtime's module is imported, which under Node replaces the
  // global Worker class.
  readonly beforeRuntime: () => void;
  readonly runtimeStarted: (runtime: RuntimeHandle) => void;
  readonly storageMounted: (storage: MountedStorage) => void;
  // Runs the user backend's seal.
  readonly seal: (seal: () => void) => void;
  // A request for the lock wasn't granted at once, so the host waits.
  readonly waiting: (lock: string) => void;
  // Before the next piece of the engine's data, fed bytes into the install,
  // reaches the tar decoder; the install waits for a promise.
  readonly beforePiece: (fed: number) => Promise<void> | undefined;
  // Answers a request itself, or undefined to have the runtime dispatch it.
  // A promise has the host leave its request loop until it settles.
  readonly serve: (request: Uint8Array) => InstrumentReply | Promise<InstrumentReply> | undefined;
  // A reply was published, and mode is the reqMode the host then read for
  // it.
  readonly replied: (mode: number) => void;
  // whileAsleep: the request arrived while the host slept, rather than
  // before it started a wait.
  readonly requestServed: (whileAsleep: boolean) => void;
  // The host left its request loop for its event loop.
  readonly eventLoopTurn: () => void;
  readonly topUpsHeld: () => boolean;
  readonly toppedUp: (workers: number, ms: number, createMs: number) => void;
}

const none: Instruments = {
  forceBrotliFallback: false,
  brotliDecoder: () => {},
  fetching: () => {},
  window: () => {},
  swept: () => {},
  beforeMark: () => undefined,
  beforeProbe: () => {},
  beforeRuntime: () => {},
  runtimeStarted: () => {},
  storageMounted: () => {},
  seal: (seal) => seal(),
  waiting: () => {},
  beforePiece: () => undefined,
  serve: () => undefined,
  replied: () => {},
  requestServed: () => {},
  eventLoopTurn: () => {},
  topUpsHeld: () => false,
  toppedUp: () => {},
};

export const Instruments: Context.Reference<Instruments> = Context.Reference<Instruments>(
  "@ibus-web/worker-host/Instruments",
  { defaultValue: () => none },
);
