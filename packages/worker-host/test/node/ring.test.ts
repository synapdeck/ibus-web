// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterAll, describe, test } from "vitest";
import { nodeHarness } from "./harness.ts";
import {
  largeCommit,
  fullRingReply,
  fullRingAppend,
  idleFullRing,
  idleRequestOrder,
  fullRingTrap,
  fullRingRelayCrash,
} from "../shared/ring.ts";
const h = await nodeHarness();
afterAll(() => h.cleanUp());
describe.each(h.data.runtimes)("ring on $name", (runtime) => {
  for (const [name, scenario] of Object.entries({
    largeCommit,
    fullRingReply,
    fullRingAppend,
    idleFullRing,
    idleRequestOrder,
    fullRingTrap,
    fullRingRelayCrash,
  }))
    test(name, () => scenario(h, runtime));
});
