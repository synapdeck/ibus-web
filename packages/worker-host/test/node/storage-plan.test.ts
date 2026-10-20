// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, expect, test, vi } from "vitest";
import type { WasmModuleManifest } from "@ibus-web/protocol";
import { checkMemory } from "../../src/worker/runtime.ts";
import { Held } from "../../src/worker/storage/held.ts";
import { memoryFor, planStorage, type StoragePlan } from "../../src/worker/storage/plan.ts";

const root = "/nix/store/00000000000000000000000000000000-schemas";
const engine: WasmModuleManifest = {
  name: "test",
  version: "1",
  license: "MIT",
  runtimeAbi: 1,
  runtimeIdentity: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  protocol: 1,
  memory: 131072,
  threads: 0,
  module: { url: "https://example.test/test.wasm", size: 1 },
  data: [
    { storePath: root, url: "https://example.test/schemas.tar", size: 65536, files: 1, encoding: "identity" },
    {
      storePath: "/nix/store/11111111111111111111111111111111-data",
      url: "https://example.test/data.tar",
      size: 1,
      files: 1,
      encoding: "identity",
    },
  ],
  settingsSchemaDir: `${root}/schemas`,
  engines: [{ name: "test", displayName: "test", languages: [], keyboard: { layout: "us", passThrough: [] } }],
  settingsSchemas: [],
};
const memory = { initial: 131072, maximum: 262144 };
// What WasmFS's memory backend takes for each entry beside a file's data.
const FILE_BYTES = 512;

afterEach(() => vi.unstubAllGlobals());

test("storage none reserves whole pages for all installed closure data", async () => {
  const plan = await planStorage({ kind: "none" }, engine, 1, new Held());
  expect(plan.mount).toBe("none");
  expect(memoryFor(memory, plan, engine, FILE_BYTES)).toEqual({ initial: 262144, maximum: 393216 });
});

test("the browser memory fallback reserves the same closure allowance", async () => {
  vi.stubGlobal("indexedDB", undefined);
  const plan = await planStorage({ kind: "browser" }, engine, 1, new Held());
  expect(plan.mount).toBe("memory");
  expect(memoryFor(memory, plan, engine, FILE_BYTES)).toEqual({ initial: 262144, maximum: 393216 });
});

test("the memory fallback allows for each entry of the data beside its bytes", async () => {
  const plan = await planStorage({ kind: "none" }, engine, 1, new Held());
  const entries = { ...engine, data: engine.data.map((entry) => ({ ...entry, files: 200 })) };
  // 65,537 bytes of data and 400 entries of 512 bytes: 270,337 bytes, five pages.
  expect(memoryFor(memory, plan, entries, FILE_BYTES)).toEqual({ initial: 458752, maximum: 589824 });
});

test.each<StoragePlan>([
  { mount: "node", hostPath: "/tmp/engine", readOnly: false },
  { mount: "indexeddb", database: "engine", flags: 0, readOnly: false },
])("disk-backed $mount data does not consume the engine's memory allowance", (plan) => {
  expect(memoryFor(memory, plan, engine, FILE_BYTES)).toEqual(memory);
});

test("storage none rejects a closure that takes total memory above the runtime maximum", async () => {
  const plan = await planStorage({ kind: "none" }, engine, 1, new Held());
  const total = memoryFor({ initial: 196608, maximum: 196608 }, plan, engine, FILE_BYTES);
  expect(() => checkMemory(total, { minimum: 65536, maximum: 262144 })).toThrow(/memory 327680.*262144/);
});
