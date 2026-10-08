// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Schedule } from "effect";
import { TestClock } from "effect/testing";
import { makeRestarter } from "../../../src/router/restart.ts";
import { CoreConfig } from "../../../src/services/config.ts";

it.effect("restart is immediate, then backs off 250 ms, and fails on three crashes in 60 seconds", () =>
  Effect.gen(function* () {
    const policy = yield* makeRestarter(CoreConfig.defaults.restart, () => Effect.void);
    expect(policy.record(0)).toBe(true);
    yield* policy.wait("test", "read-only");
    expect(policy.record(100)).toBe(true);
    let restarted = false;
    const next = yield* policy.wait("test", "read-only").pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          restarted = true;
        }),
      ),
      Effect.forkScoped,
    );
    yield* TestClock.adjust(249);
    expect(restarted).toBe(false);
    yield* TestClock.adjust(1);
    yield* Fiber.join(next);
    expect(restarted).toBe(true);
    expect(policy.record(59999)).toBe(false);
    expect(policy.record(60101)).toBe(true);
  }),
);

it.effect("restart waits for the named writer lock, read-only skips it, and timeout cancels the wait", () =>
  Effect.gen(function* () {
    const names: string[] = [];
    let released = false;
    const policy = yield* makeRestarter(Schedule.forever, (name) =>
      Effect.gen(function* () {
        names.push(name);
        yield* Effect.sleep(1000);
        released = true;
      }),
    );
    const fiber = yield* policy.wait("hangul", undefined).pipe(Effect.forkScoped);
    yield* TestClock.adjust(999);
    expect(released).toBe(false);
    yield* TestClock.adjust(1);
    yield* Fiber.join(fiber);
    expect(names).toEqual(["hangul"]);
    yield* policy.wait("hangul", "read-only");
    expect(names).toHaveLength(1);
    let canceled = false;
    const stuck = yield* makeRestarter(Schedule.forever, () =>
      Effect.never.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            canceled = true;
          }),
        ),
      ),
    );
    const timeout = yield* stuck.wait("hangul", "closed").pipe(Effect.exit, Effect.forkScoped);
    yield* TestClock.adjust(10000);
    expect((yield* Fiber.join(timeout))._tag).toBe("Failure");
    expect(canceled).toBe(true);
  }),
);

it.effect("a caller-supplied schedule controls delays and exhaustion", () =>
  Effect.gen(function* () {
    const policy = yield* makeRestarter(Schedule.recurs(0), () => Effect.void);
    expect((yield* Effect.exit(policy.wait("test", "read-only")))._tag).toBe("Failure");
  }),
);
