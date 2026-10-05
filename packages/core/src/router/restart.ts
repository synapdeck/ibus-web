// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Effect, Schedule } from "effect";
import { engineWriterLock, type StorageState } from "@ibus-web/worker-host";

export type WaitForWriter = (name: string) => Effect.Effect<void, Error>;

export const waitForWriter: WaitForWriter = (name) =>
  Effect.tryPromise({
    try: (signal) => navigator.locks.request(engineWriterLock({ name }), { mode: "exclusive", signal }, () => {}),
    catch: (cause) => new Error(`Writer lock failed for ${name}`, { cause }),
  });

export const makeRestarter = (schedule: Schedule.Schedule<unknown>, writer: WaitForWriter = waitForWriter) =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStepWithSleep(schedule);
    let crashes: number[] = [];
    return {
      record: (now: number): boolean => {
        crashes = crashes.filter((time) => now - time < 60000);
        crashes.push(now);
        return crashes.length < 3;
      },
      wait: (name: string, storage: StorageState | undefined): Effect.Effect<void, Error> =>
        Effect.gen(function* () {
          yield* step(undefined).pipe(Effect.catchCause(() => Effect.fail(new Error("Restart schedule exhausted"))));
          if (storage !== "read-only")
            yield* writer(name).pipe(
              Effect.timeout(10000),
              Effect.mapError((cause) => new Error(`Writer lock unavailable for ${name}`, { cause })),
            );
        }),
    };
  });
