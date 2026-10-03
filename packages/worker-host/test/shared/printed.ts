// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the host's threads print, as the test environment collects it: a test
// takes the lines it expects, and any other fails it.

import { expect } from "vitest";
import type { Clock } from "./client.ts";

export interface Printed {
  // Takes the printed lines matching pattern, waiting up to waitMs for at
  // least min of them, and failing unless there are that many, or exactly
  // count.
  take(pattern: RegExp, options?: { count?: number; min?: number; waitMs?: number }): Promise<string[]>;
  // Fails unless nothing else was printed, once output in flight has had
  // settleMs to arrive.
  nothingElse(settleMs?: number): Promise<void>;
}

// Output reaches the test only through the environment's event loop, a
// little after it was printed.
const SETTLE_MS = 50;

// drain() hands over the lines printed since it was last called.
export const printedFrom = (drain: () => string[] | Promise<string[]>, clock: Clock): Printed => {
  const lines: string[] = [];
  const collect = async (): Promise<void> => {
    lines.push(...(await drain()));
  };
  return {
    async take(pattern, { count, min = count ?? 1, waitMs = 2000 } = {}) {
      const deadline = clock.now() + waitMs;
      for (;;) {
        await collect();
        if (lines.filter((line) => pattern.test(line)).length >= min || clock.now() >= deadline) break;
        await clock.sleep(10);
      }
      await clock.sleep(SETTLE_MS);
      await collect();
      const taken = lines.filter((line) => pattern.test(line));
      if (count === undefined) expect(taken.length, `printed lines matching ${pattern}`).toBeGreaterThanOrEqual(min);
      else expect(taken, `printed lines matching ${pattern}`).toHaveLength(count);
      for (const line of taken) lines.splice(lines.indexOf(line), 1);
      return taken;
    },
    async nothingElse(settleMs = SETTLE_MS) {
      await clock.sleep(settleMs);
      await collect();
      expect(lines.splice(0), "printed nothing else").toEqual([]);
    },
  };
};
