// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The host's scenarios in a browser, the host in a Worker started by URL and
// the page spinning for each reply. heap-full runs under Node only, and so
// does the host as released: it imports Effect, its peer dependency, by its
// bare name, which a browser resolves only once the page's bundler has, and
// Vitest's own server rewrites every module it serves for its runner.

import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from "vitest";
import type { RunningHost } from "../shared/harness.ts";
import { failedInstantiate, refusedMemory, relayFailure, topUpLimit } from "../shared/lifecycle.ts";
import {
  coldWake,
  crashPrinted,
  crossThreadWake,
  deadline,
  dispatch,
  exceptions,
  glibStress,
  memStress,
  noLateReplies,
  poolExhausted,
  poolExhaustedPrinted,
  poolTopUp,
  syncProxied,
  threadCrash,
  threadCreateBlocked,
  threadExitBlocked,
} from "../shared/scenarios.ts";
import { browserHarness } from "./harness.ts";

const h = await browserHarness();

beforeEach(() => h.printed.nothingElse());
afterEach(() => h.printed.nothingElse());

describe.each(h.data.runtimes)("the $name runtime", (runtime) => {
  // In order: thread-create-blocked and pool-top-up need the pool as it
  // started, before any other scenario leaves a thread alive or grows it.
  describe("one host", () => {
    let host: RunningHost;
    beforeAll(async () => {
      host = await h.start({ runtime });
    });
    afterAll(() => host?.terminate());
    afterEach(() => noLateReplies(host.client));

    test("dispatch", () => dispatch(h, host));
    test("cold-wake", () => coldWake(h, host));
    test("thread-create-blocked", () => threadCreateBlocked(h, host));
    test("pool-top-up", () => poolTopUp(h, host));
    test("thread-exit-blocked", () => threadExitBlocked(h, host));
    test("cross-thread-wake", () => crossThreadWake(h, host));
    test("deadline", () => deadline(h, host));
    test("sync-proxied", () => syncProxied(h, host));
    test("exceptions", () => exceptions(h, host));
    test("pool-exhausted", async () => {
      await poolExhausted(h, host);
      await poolExhaustedPrinted(h, runtime);
    });
  });

  // Each of these takes its host down, or needs one of its own.
  const ownHost = async (use: (host: RunningHost) => Promise<void>): Promise<void> => {
    const host = await h.start({ runtime });
    try {
      await use(host);
    } finally {
      await host.terminate();
    }
  };

  test("thread-crash", () =>
    ownHost(async (host) => {
      await threadCrash(h, host);
      await crashPrinted(h, runtime);
    }));

  test("mem-stress", () => ownHost((host) => memStress(h, host)));
  test("glib-stress", () => ownHost((host) => glibStress(h, host)));
});

describe.each(h.data.runtimes)("the host on the $name runtime", (runtime) => {
  test("fails to start when the runtime fails to instantiate", () => failedInstantiate(h, runtime));
  test("refuses a memory the runtime can't take", () => refusedMemory(h, runtime));
  test("reports a relay that fails as a crash", () => relayFailure(h, runtime));
  test("logs a top-up that doesn't finish in time, and tops up no more", () => topUpLimit(h, runtime));
});
