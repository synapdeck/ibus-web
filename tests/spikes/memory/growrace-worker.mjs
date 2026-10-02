// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A reader for growrace.mjs, in a browser Worker or a worker thread of Node
// or Bun: instantiates the module over the shared memory, reports that it is
// ready, then spins until the grower is done, or traps.

const { parentPort } =
  typeof process === "object" ? await import("node:worker_threads") : {};
const post = (message) => (parentPort ?? self).postMessage(message);
const start = ({ memory, module, mode }) => {
  const instance = new WebAssembly.Instance(module, {
    env: { memory, poke: () => {} },
  });
  post({ type: "ready" });
  try {
    post({ type: "done", count: instance.exports.spin(mode) });
  } catch (error) {
    post({ type: "trap", message: String(error) });
  }
};
if (parentPort) parentPort.once("message", start);
else self.onmessage = ({ data }) => start(data);
