// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Cause, Effect, Exit } from "effect";

/**
 * A handler's result, running it first if it is an Effect. Throws what the Effect failed with. An Effect that reaches
 * an asynchronous boundary throws too, its fiber interrupted: the host may leave its synchronous section later, and
 * the rest of the Effect must not run then, outside any request.
 */
export const run = <A>(result: A | Effect.Effect<A, unknown>): A => {
  if (!Effect.isEffect(result)) return result;

  const exit = Effect.runSyncExit(result);
  if (Exit.isSuccess(exit)) return exit.value;

  for (const reason of exit.cause.reasons)
    if (Cause.isDieReason(reason) && Cause.isAsyncFiberError(reason.defect)) reason.defect.fiber.interruptUnsafe();
  throw Cause.squash(exit.cause);
};
