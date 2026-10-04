// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Run a command repeatedly with one CPU-bound Worker per available CPU.
// Usage: node test/node/saturate.ts RUNS COMMAND [ARG...]
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import process from "node:process";
import { Worker } from "node:worker_threads";

const [count, command, ...args] = process.argv.slice(2);
const runs = Number(count);
if (!Number.isSafeInteger(runs) || runs < 1 || command === undefined)
  throw new Error("usage: saturate.ts RUNS COMMAND [ARG...]");
const stopped = new Int32Array(new SharedArrayBuffer(4));
const workers: Worker[] = [];
const controller = new AbortController();
const stop = () => {
  Atomics.store(stopped, 0, 1);
  controller.abort();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
// A lost test must never leave saturation running unattended.
const deadline = setTimeout(stop, 30 * 60_000);
let failed = 0;
try {
  await Promise.all(
    Array.from(
      { length: availableParallelism() },
      () =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(
            `
      const { workerData, parentPort } = require("node:worker_threads");
      const stopped = new Int32Array(workerData);
      parentPort.postMessage("busy");
      let value = 1;
      while (Atomics.load(stopped, 0) === 0) {
        for (let i = 0; i < 100000; i++) value = Math.imul(value, 1664525) + 1013904223 | 0;
      }
      parentPort.postMessage(value);
    `,
            { eval: true, workerData: stopped.buffer },
          );
          workers.push(worker);
          worker.once("message", () => resolve());
          worker.once("error", (error) => {
            stop();
            reject(error);
          });
          worker.once("exit", (code) => {
            if (code !== 0) {
              stop();
              reject(new Error(`load Worker exited ${code}`));
            }
          });
        }),
    ),
  );
  console.log(JSON.stringify({ event: "saturation-start", workers: workers.length, runs }));
  for (let run = 1; run <= runs && !controller.signal.aborted; run++) {
    const started = Date.now();
    const code = await new Promise<number | null>((resolve, reject) => {
      // A separate process group also owns Vitest's child processes. Stop
      // all of them when interrupted, rather than leave an orphaned test.
      const child = spawn(command, args, { stdio: "inherit", detached: true });
      const abort = () => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      };
      controller.signal.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => {
        controller.signal.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("exit", (code) => {
        controller.signal.removeEventListener("abort", abort);
        resolve(code);
      });
    });
    if (code !== 0) failed++;
    console.log(JSON.stringify({ event: "run", run, code, elapsedMs: Date.now() - started }));
  }
  process.exitCode = failed === 0 && !controller.signal.aborted ? 0 : 1;
} finally {
  Atomics.store(stopped, 0, 1);
  await Promise.all(workers.map((worker) => worker.terminate()));
  clearTimeout(deadline);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  console.log(JSON.stringify({ event: "saturation-stopped", workers: workers.length, failed }));
}
