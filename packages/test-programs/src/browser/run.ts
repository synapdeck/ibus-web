// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Runs one program in a dedicated Worker of its own and collects its output
// and report until it exits, fails or runs out of time.

import type { OutputLine, Program, ProgramRun, Report, StartMessage, WorkerMessage } from "../shared/protocol.ts";

// Served as written, beside the programs, rather than through Vite.
export const workerUrl = "/@ibus-web-test-programs/worker/program.js";

export const runProgram = (program: Program, args: readonly string[], timeoutMs: number): Promise<ProgramRun> =>
  new Promise((resolve) => {
    const output: OutputLine[] = [];
    let report: Report | undefined;
    const began = performance.now();
    const worker = new Worker(workerUrl, { type: "module" });
    let finished = false;
    // Terminating the Worker ends the program's pthreads, its nested
    // Workers, with it.
    const finish = (exitCode: number | null, error?: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker.terminate();
      const run: ProgramRun = { output, exitCode, durationMs: performance.now() - began };
      if (error !== undefined) run.error = error;
      if (report !== undefined) run.report = report;
      resolve(run);
    };
    const timer = setTimeout(() => finish(null, `no exit in ${timeoutMs} ms`), timeoutMs);
    worker.addEventListener("message", ({ data }: MessageEvent<WorkerMessage>) => {
      switch (data.kind) {
        case "output":
          output.push(data.line);
          break;
        case "report":
          report = { format: data.format, text: data.text };
          break;
        case "exit":
          finish(data.code);
          break;
        case "error":
          finish(null, data.message);
          break;
      }
    });
    // A Worker script that fails to load or parse reports here, with no
    // detail beyond the event's message.
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      finish(null, `Worker error: ${event.message || "the script failed to load"}`);
    });
    worker.addEventListener("messageerror", () => finish(null, "a message from the Worker could not be deserialized"));
    const start: StartMessage = { url: new URL(program.url, location.href).href, args: [...program.args, ...args] };
    worker.postMessage(start);
  });

const settle = (request: IDBOpenDBRequest, name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error(`couldn't delete IndexedDB database ${name}: ${request.error?.message}`));
    // Every program's Worker is gone by now, so nothing holds a connection
    // open for long.
    request.onblocked = () => {};
  });

// Deletes every IndexedDB database of the origin.
export const clearStorage = async (): Promise<void> => {
  const databases = await indexedDB.databases();
  await Promise.all(
    databases.flatMap(({ name }) => (name === undefined ? [] : [settle(indexedDB.deleteDatabase(name), name)])),
  );
};
