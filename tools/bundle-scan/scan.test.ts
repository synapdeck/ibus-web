// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { scanChunk } from "./scan.ts";
test("rejects actual inline host executable even after its path identity is lost", async () => {
  const host = await readFile(
    new URL("../../packages/worker-host/dist/worker/index.js", new URL("./", import.meta.url)),
    "utf8",
  );
  expect(() => scanChunk(host, ["/consumer/inline.js"])).toThrow(/worker|runtime|Emscripten/i);
});
test("rejects imported host implementation and allows the shared transport ABI", () => {
  expect(() => scanChunk("export const x = 1", ["/packages/worker-host/dist/worker/index.js"])).toThrow();
  expect(() => scanChunk("export const x = 1", ["/packages/worker-host/dist/shared/index.js"])).not.toThrow();
});
test.each([
  "WebAssembly.instantiate(bytes)",
  "const bytes = '\\x00asm'",
  "_ibusweb_process_key()",
  "HEAPU8.set(bytes)",
])("rejects executable marker %s", (code) => {
  expect(() => scanChunk(code, ["/consumer/page.js"])).toThrow();
});
