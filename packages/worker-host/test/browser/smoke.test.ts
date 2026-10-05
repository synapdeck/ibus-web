// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { afterAll, describe, test } from "vitest";
import { browserHarness } from "./harness.ts";
import { protocolRoundtrip, replySequence } from "../shared/protocol.ts";

const h = await browserHarness();
afterAll(() => h.cleanUp());
describe.each(h.data.runtimes)("Worker smoke on $name", (runtime) => {
  for (const [name, scenario] of Object.entries({ protocolRoundtrip, replySequence }))
    test(name, async () => {
      const host = await h.start({ runtime });
      try {
        await scenario(h, host);
      } finally {
        await host.terminate();
      }
    });
});
