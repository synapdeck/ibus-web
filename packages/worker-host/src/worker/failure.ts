// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// How the host's scopes fail, and whether a failure left the runtime fit to
// call: only then do finalizers call into it.

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
export class RuntimeStopped extends Data.TaggedError("RuntimeStopped")<{ readonly error: unknown }> {}

export class RelayFailed extends Data.TaggedError("RelayFailed")<{ readonly message: string }> {}

// In a browser, a thread's uncaught error reaches this thread as the
// ErrorEvent its Worker fired, which Emscripten rethrows.
export const describe = (error: unknown): string => {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  if (typeof ErrorEvent === "function" && error instanceof ErrorEvent)
    return `${error.message} (${error.filename}:${error.lineno})`;
  return String(error);
};

// A failure outside the runtime: importing or instantiating it, the locks,
// the probe.
export const startupFailed = (error: unknown): StartupFailed => new StartupFailed({ message: describe(error) });

// A failure in a block that calls into the runtime. Only a failure the host
// raised itself, an error the runtime returned or a refusal before a call,
// leaves the runtime fit to call; whatever else was thrown, a trap, an
// abort, a WebAssembly exception, a stack overflow, an error in Emscripten's
// glue, an exit or an unwind, may have come from inside it.
export const runtimeCallFailed = (error: unknown): StartupFailed =>
  new StartupFailed({ message: describe(error), trapped: !(error instanceof RuntimeRefused) });

// Whether the runtime may still be called once a scope closes with exit:
// not once a call into it has thrown, since after a trap its memory can't
// be trusted.
export const runtimeIntact = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isSuccess(exit) ||
  !exit.cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      (reason.error instanceof RuntimeStopped ||
        (reason.error instanceof StartupFailed && reason.error.trapped === true)),
  );

// Registers a finalizer that calls into the runtime: it runs only while the
// runtime is intact.
export const runtimeFinalizer = <R>(
  release: Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R | Scope.Scope> =>
  Effect.addFinalizer((exit) => (runtimeIntact(exit) ? release : Effect.void));
