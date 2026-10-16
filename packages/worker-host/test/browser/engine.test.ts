// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterAll, describe, expect, test } from "vitest";
import { browserHarness } from "./harness.ts";
import {
  manifestUrl,
  manifestFailures,
  engineLifecycle,
  storeBeforeInit,
  engineFault,
  engineLoadFailure,
  engineShutdown,
  enginePoolWarm,
} from "../shared/engine.ts";
const h = await browserHarness();
afterAll(() => h.cleanUp());
describe.each(h.data.runtimes)("engine on $name", (runtime) => {
  test("manifest URL resolves relative module and data URLs", () => manifestUrl(h, runtime));
  test("manifest validation", () => manifestFailures(h, runtime));
  for (const memory of [false, true]) {
    test("engine lifecycle, memory=" + memory, () => engineLifecycle(h, runtime, memory));
    test("store before Init, memory=" + memory, () => storeBeforeInit(h, runtime, memory));
  }
  test("engine fault", () => engineFault(h, runtime));
  test("engine shutdown", () => engineShutdown(h, runtime));
  test("pool warmed once the engine loads", () => enginePoolWarm(h, runtime));
  test("engine load failure", () => engineLoadFailure(h, runtime));
});

test("missing or malformed constants.json fails host startup with its filename", async () => {
  for (const url of h.data.brokenRuntimes)
    await expect(h.start({ runtime: { name: "released", url } })).rejects.toThrow(/constants\.json/);
});
