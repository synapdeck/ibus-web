// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// How the host's scopes fail, and whether a failure left the runtime fit to
// call: only then do finalizers call into it.

import { errorReport } from "@ibus-web/protocol";
import { Cause, Data, Effect, Exit, type Scope } from "effect";
import { RuntimeRefused } from "./runtime.ts";

// trapped: a call into the runtime threw, so the runtime can't be called
// again.
export class StartupFailed extends Data.TaggedError("StartupFailed")<{
  readonly message: string;
  readonly trapped?: boolean;
}> {}

// A call into the runtime threw: a trap, an abort, or Emscripten unwinding
// the host for another thread's crash.
export class RuntimeStopped extends Data.TaggedError("RuntimeStopped")<{
  readonly error: unknown;
  readonly reason?: number;
}> {}

export class RelayFailed extends Data.TaggedError("RelayFailed")<{ readonly message: string }> {}

// A failure in a step that calls nothing in a runtime the host keeps: the
// locks, the probe, the store's own IndexedDB or file work, the relay, or
// starting the runtime, whose start function and constructors do run inside
// it, but which is never handed back to be called if they throw.
export const startupFailed = (error: unknown): StartupFailed => new StartupFailed({ message: errorReport(error) });

// A failure in a block that calls into the runtime. Only a failure the host
// raised itself, an error the runtime returned or a refusal before a call,
// leaves the runtime fit to call; whatever else was thrown, a trap, an
// abort, a WebAssembly exception, a stack overflow, an error in Emscripten's
// glue, an exit or an unwind, may have come from inside it.
export const runtimeCallFailed = (error: unknown): StartupFailed =>
  new StartupFailed({ message: errorReport(error), trapped: !(error instanceof RuntimeRefused) });

// Whether the runtime may still be called once a scope closes with exit:
// not once a call into it has thrown, since after a trap its memory can't
// be trusted.
const runtimeBroken = (error: unknown): boolean =>
  error instanceof RuntimeStopped || (error instanceof StartupFailed && error.trapped === true);

export const runtimeIntact = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isSuccess(exit) ||
  !exit.cause.reasons.some((reason) =>
    Cause.isFailReason(reason)
      ? runtimeBroken(reason.error)
      : Cause.isDieReason(reason)
        ? runtimeBroken(reason.defect)
        : false,
  );

// Registers a finalizer that calls into the runtime: it runs only while the
// runtime is intact.
export const runtimeFinalizer = <R>(
  release: Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R | Scope.Scope> =>
  Effect.addFinalizer((exit) => (runtimeIntact(exit) ? release : Effect.void));
