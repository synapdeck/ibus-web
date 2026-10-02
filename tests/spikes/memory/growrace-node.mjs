// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node growrace-node.mjs [READERS [PAGES [RUNS]]]
//        bun growrace-node.mjs [READERS [PAGES [RUNS]]]
//
// growrace.mjs's matrix on worker threads: RUNS races of each access with
// the memory growing, and of the atomic one on a memory that never grows.
// Prints a line per race, a row per configuration, then RESULTS and a line
// of JSON. Exits 1 if any reader trapped.

import { Worker } from "node:worker_threads";
import { matrix } from "./growrace.mjs";

const [readers = 16, pages = 8192, runs = 5] = process.argv
  .slice(2)
  .map(Number);
const startWorker = () => {
  const worker = new Worker(new URL("./growrace-worker.mjs", import.meta.url));
  return {
    post: (message) => worker.postMessage(message),
    onMessage: (listener) => worker.on("message", listener),
    terminate: () => worker.terminate(),
  };
};
const engine =
  typeof Bun === "object" ? `Bun ${Bun.version}` : `Node ${process.version}`;
const rows = await matrix({
  readers,
  pages,
  runs,
  startWorker,
  report: (line) => console.log(line),
});
for (const { access, grow, runs, trapped, readersTrapped, trap } of rows)
  console.log(
    `${engine}: ${access}${grow ? "" : ", never grown"}: ${trapped} of ${runs} races trapped ` +
      `(${readersTrapped} readers)${trap === null ? "" : `: ${trap}`}`,
  );
console.log(`RESULTS ${JSON.stringify({ engine, readers, pages, rows })}`);
process.exit(rows.some(({ trapped }) => trapped > 0) ? 1 : 0);
