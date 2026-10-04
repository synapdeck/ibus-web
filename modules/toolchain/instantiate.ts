// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Instantiates a runtime-linked program with the memory a host must make for
// it: shared, fixed at the given number of 64 KiB pages.
//
//   instantiate.ts <pages> <program.js>

import path from "node:path";
import { pathToFileURL } from "node:url";

const [pages, program] = process.argv.slice(2);
if (pages === undefined || program === undefined) {
  console.error("usage: instantiate.ts <pages> <program.js>");
  process.exit(1);
}
const size = Number(pages);
const { default: instantiate } = (await import(pathToFileURL(path.resolve(program)).href)) as {
  default: (module: { wasmMemory: WebAssembly.Memory; ibuswebEngineThreads: number }) => Promise<unknown>;
};
await instantiate({
  ibuswebEngineThreads: 0,
  wasmMemory: new WebAssembly.Memory({ initial: size, maximum: size, shared: true }),
});
