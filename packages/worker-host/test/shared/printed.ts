// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the host's threads print, as the test environment collects it: a test
// takes the lines it expects, and any other fails it.

import { expect } from "vitest";
import type { Clock } from "./client.ts";

export interface Printed {
  // Takes the printed lines matching pattern, waiting up to waitMs for at
  // least min of them, and failing unless there are that many, or exactly
  // count, once output in flight has arrived.
  take(pattern: RegExp, options?: { count?: number; min?: number; waitMs?: number }): Promise<string[]>;
  // Fails unless nothing else was printed, once output in flight has
  // arrived.
  nothingElse(): Promise<void>;
}

// How long take() waits for lines by default: a bound for a loaded machine,
// which a test only reaches when the lines never come.
const WAIT_MS = 10_000;

// drain() hands over the lines printed since it was last called; settled()
// does too, but only once everything printed before the call has arrived.
export const printedFrom = (
  drain: () => string[] | Promise<string[]>,
  settled: () => string[] | Promise<string[]>,
  clock: Clock,
): Printed => {
  const lines: string[] = [];
  const collect = async (): Promise<void> => {
    lines.push(...(await drain()));
  };
  return {
    async take(pattern, { count, min = count ?? 1, waitMs = WAIT_MS } = {}) {
      const deadline = clock.now() + waitMs;
      for (;;) {
        await collect();
        if (lines.filter((line) => pattern.test(line)).length >= min || clock.now() >= deadline) break;
        await clock.sleep(10);
      }
      lines.push(...(await settled()));
      const taken = lines.filter((line) => pattern.test(line));
      if (count === undefined) expect(taken.length, `printed lines matching ${pattern}`).toBeGreaterThanOrEqual(min);
      else expect(taken, `printed lines matching ${pattern}`).toHaveLength(count);
      for (const line of taken) lines.splice(lines.indexOf(line), 1);
      return taken;
    },
    async nothingElse() {
      lines.push(...(await settled()));
      expect(lines.splice(0), "printed nothing else").toEqual([]);
    },
  };
};
