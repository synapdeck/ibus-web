// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { TestClock } from "effect/testing";
import { progressOn } from "../../src/worker/install/wait.ts";

afterEach(() => vi.restoreAllMocks());

describe("install lock progress", () => {
  for (const [ending, exit] of [
    ["success", Exit.void],
    ["failure", Exit.fail("install failed")],
    ["interruption", Exit.interrupt()],
  ] as const)
    it.effect(`announces between pieces and stops on ${ending}`, () =>
      Effect.gen(function* () {
        // Observe the real channel's posts without depending on when Node
        // delivers messages on its event loop alongside the fake clock.
        const sent = vi.spyOn(BroadcastChannel.prototype, "postMessage");
        const closed = vi.spyOn(BroadcastChannel.prototype, "close");
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
        yield* Scope.provide(scope)(progressOn(`install-progress-${crypto.randomUUID()}`, 50));
        expect(sent).toHaveBeenCalledTimes(1);
        yield* TestClock.adjust(49);
        expect(sent).toHaveBeenCalledTimes(1);
        yield* TestClock.adjust(1);
        expect(sent).toHaveBeenCalledTimes(2);
        yield* TestClock.adjust(150);
        expect(sent).toHaveBeenCalledTimes(5);
        yield* Scope.close(scope, exit);
        expect(closed).toHaveBeenCalledTimes(1);
        yield* TestClock.adjust(500);
        expect(sent).toHaveBeenCalledTimes(5);
      }),
    );
});
