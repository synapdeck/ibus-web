// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterAll, describe, test } from "vitest";
import { browserHarness } from "./harness.ts";
import {
  protocolRoundtrip,
  replySequence,
  requestModes,
  timerOutput,
  crashWinsReply,
  crashWinsRequestPublication,
  crashWinsTakingReply,
  crashRejectsAsyncReply,
} from "../shared/protocol.ts";
test("a relay crash wins either reply ordering", crashWinsReply);
test("a relay crash wins request publication", crashWinsRequestPublication);
test("a relay crash wins taking a reply", crashWinsTakingReply);
test("a relay crash rejects the asynchronous reply waiter", crashRejectsAsyncReply);
const h = await browserHarness();
afterAll(() => h.cleanUp());
describe.each(h.data.runtimes)("protocol on $name", (runtime) => {
  for (const [name, scenario] of Object.entries({ protocolRoundtrip, replySequence, requestModes, timerOutput }))
    test(name, async () => {
      const host = await h.start({ runtime });
      try {
        await scenario(h, host);
      } finally {
        await host.terminate();
      }
    });
});
