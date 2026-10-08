// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, expect, test, vi } from "vitest";
import type { EngineManifest } from "@ibus-web/protocol";
import { checkMemory } from "../../src/worker/runtime.ts";
import { Held } from "../../src/worker/storage/held.ts";
import { memoryFor, planStorage, type StoragePlan } from "../../src/worker/storage/plan.ts";

const root = "/nix/store/00000000000000000000000000000000-schemas";
const engine: EngineManifest = {
  name: "test",
  version: "1",
  license: "MIT",
  runtimeAbi: 1,
  protocol: 1,
  memory: 131072,
  threads: 0,
  module: { url: "https://example.test/test.wasm", size: 1 },
  data: [
    { storePath: root, url: "https://example.test/schemas.tar", size: 65536, encoding: "identity" },
    {
      storePath: "/nix/store/11111111111111111111111111111111-data",
      url: "https://example.test/data.tar",
      size: 1,
      encoding: "identity",
    },
  ],
  settingsSchemaDir: `${root}/schemas`,
  engines: ["test"],
  keyboard: { layout: "us", passThrough: [] },
  settingsSchemas: [],
};
const memory = { initial: 131072, maximum: 262144 };

afterEach(() => vi.unstubAllGlobals());

test("storage none reserves whole pages for all installed closure data", async () => {
  const plan = await planStorage({ kind: "none" }, engine, 1, new Held());
  expect(plan.mount).toBe("none");
  expect(memoryFor(memory, plan, engine)).toEqual({ initial: 262144, maximum: 393216 });
});

test("the browser memory fallback reserves the same closure allowance", async () => {
  vi.stubGlobal("indexedDB", undefined);
  const plan = await planStorage({ kind: "browser" }, engine, 1, new Held());
  expect(plan.mount).toBe("memory");
  expect(memoryFor(memory, plan, engine)).toEqual({ initial: 262144, maximum: 393216 });
});

test.each<StoragePlan>([
  { mount: "node", hostPath: "/tmp/engine", readOnly: false },
  { mount: "indexeddb", database: "engine", flags: 0, readOnly: false },
])("disk-backed $mount data does not consume the engine's memory allowance", (plan) => {
  expect(memoryFor(memory, plan, engine)).toEqual(memory);
});

test("storage none rejects a closure that takes total memory above the runtime maximum", async () => {
  const plan = await planStorage({ kind: "none" }, engine, 1, new Held());
  const total = memoryFor({ initial: 196608, maximum: 196608 }, plan, engine);
  expect(() => checkMemory(total, { minimum: 65536, maximum: 262144 })).toThrow(/memory 327680.*262144/);
});
