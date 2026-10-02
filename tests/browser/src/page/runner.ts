// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Runs one test program in a dedicated Worker of its own and collects its
// output until it exits, fails or runs out of time. The runner calls
// runProgram() through Playwright.

import type { OutputLine, ProgramReport, ProgramSpec, StartMessage, WorkerMessage } from "../shared/protocol.ts";

const runProgram = ({ url, args, timeoutMs }: ProgramSpec): Promise<ProgramReport> =>
  new Promise((resolve) => {
    const output: OutputLine[] = [];
    const worker = new Worker(new URL("../worker/program.js", import.meta.url), {
      type: "module",
    });
    let finished = false;
    // Terminating the Worker ends the program's pthreads, its nested
    // Workers, with it.
    const finish = (exitCode: number | null, error?: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(error === undefined ? { output, exitCode } : { output, exitCode, error });
    };
    const timer = setTimeout(() => finish(null, `no exit in ${timeoutMs} ms`), timeoutMs);
    worker.addEventListener("message", ({ data }: MessageEvent<WorkerMessage>) => {
      switch (data.kind) {
        case "output":
          output.push(data.line);
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
    const start: StartMessage = { url: new URL(url, location.href).href, args };
    worker.postMessage(start);
  });

Object.assign(globalThis, { runProgram });
