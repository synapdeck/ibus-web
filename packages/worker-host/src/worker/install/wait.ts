// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Waiting for a version's data and install locks, and an installer's word
// that it is still going, which keeps a waiter from giving up on it.

import { Effect, Schedule, type Scope } from "effect";
import type { HostConfigValues } from "../../shared/config.ts";
import type { HeldLock } from "../storage/held.ts";
import { requestLock } from "../storage/locks.ts";

// A lock once granted: how long the request waited, and when it was
// granted, in Date.now() milliseconds, which hosts share.
interface Granted {
  readonly lock: HeldLock;
  readonly waitMs: number;
  readonly lockedAt: number;
}

type WaitLimits = Pick<HostConfigValues, "lockRoundMs" | "lockLimitMs">;

// Requests the lock and resolves once it is held, calling waiting() first if
// it isn't free. With progress, the holder's word on the BroadcastChannel of
// that name starts the wait over. Node lets go of the locks of a
// worker_thread that is terminated, but grants a request already queued for
// one only once another request for it arrives, so the wait is made of
// requests of a round each, each made again when the last times out.
export const holdLock = async (
  name: string,
  mode: LockMode,
  limits: WaitLimits,
  waiting: () => void,
  progress?: string,
): Promise<Granted> => {
  const requestedAt = performance.now();
  const granted = (lock: HeldLock): Granted => ({
    lock,
    waitMs: performance.now() - requestedAt,
    lockedAt: Date.now(),
  });
  const now = await requestLock(name, { mode, ifAvailable: true });
  if (now !== null) return granted(now);
  waiting();
  let heard = requestedAt;
  const channel = progress === undefined ? undefined : new BroadcastChannel(progress);
  if (channel !== undefined)
    channel.onmessage = () => {
      heard = performance.now();
    };
  try {
    for (let left = limits.lockLimitMs; left > 0; left = heard + limits.lockLimitMs - performance.now()) {
      // Node takes only whole milliseconds.
      const signal = AbortSignal.timeout(Math.ceil(Math.min(limits.lockRoundMs, left)));
      try {
        const lock = await requestLock(name, { mode, signal });
        if (lock !== null) return granted(lock);
      } catch (error) {
        if ((error as { name?: unknown } | null)?.name !== "TimeoutError") throw error;
      }
    }
  } finally {
    channel?.close();
  }
  throw new Error(`${name}: not granted after ${limits.lockLimitMs} ms without word from the host holding it`);
};

// The install lock owns the channel and timer, including time spent clearing,
// mounting, fetching and sealing. Closing that scope stops the timer before
// closing the channel, so no announcement can escape the lock's lifetime.
export const progressOn = (name: string, intervalMs: number): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const channel = yield* Effect.acquireRelease(
      Effect.sync(() => new BroadcastChannel(name)),
      (channel) => Effect.sync(() => channel.close()),
    );
    yield* Effect.sync(() => channel.postMessage(null)).pipe(
      Effect.repeat(Schedule.fixed(intervalMs)),
      Effect.forkScoped({ startImmediately: true }),
    );
  });
