// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A test program's dedicated Worker. Programs are linked with -sMODULARIZE
// -sEXPORT_ES6, so their module script only exports a factory; this imports
// it and runs the program, passing its output and exit code to the page.

import type { StartMessage, WorkerMessage } from "../shared/protocol.ts";

// The settings Emscripten's factory reads that the runner uses.
interface ModuleOptions {
  arguments: string[];
  print(text: string): void;
  printErr(text: string): void;
  onExit(code: number): void;
  onAbort(what: unknown): void;
}

type Factory = (options: ModuleOptions) => Promise<unknown>;

// Resolves after every message already delivered to this Worker has been
// handled: a port's messages are handled in the order they arrive, so one
// sent to a port of our own queues behind them.
const drainMessages = (): Promise<void> =>
  new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });

const post = (message: WorkerMessage): void => postMessage(message);

// Firefox's stacks leave out the error's name and message, Chromium's start
// with them.
const describe = (error: unknown): string => {
  const head = String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  return stack === "" || stack.startsWith(head) ? stack || head : `${head}\n${stack}`;
};

addEventListener("error", (event) => {
  // Left alone, the error would also reach the page's Worker object as a
  // second report.
  event.preventDefault();
  post({ kind: "error", message: `uncaught: ${event.message}` });
});
addEventListener("unhandledrejection", (event) =>
  post({
    kind: "error",
    message: `unhandled rejection: ${describe(event.reason)}`,
  }),
);

addEventListener(
  "message",
  async ({ data: { url, args } }: MessageEvent<StartMessage>) => {
    try {
      const { default: factory } = (await import(url)) as { default: Factory };
      await factory({
        arguments: args,
        print: (text) => post({ kind: "output", line: { stream: "stdout", text } }),
        printErr: (text) => post({ kind: "output", line: { stream: "stderr", text } }),
        // A pthread's output reaches this Worker as a message, and the page
        // ends the run on "exit", so "exit" waits for the output messages
        // already delivered. A line a pthread prints just before exit can
        // still be in transit and be lost: tests report through their exit
        // code and print what they assert on from the main thread.
        onExit: (code) => void drainMessages().then(() => post({ kind: "exit", code })),
        onAbort: (what) => post({ kind: "error", message: `aborted: ${describe(what)}` }),
      });
    } catch (error) {
      post({ kind: "error", message: describe(error) });
    }
  },
  { once: true },
);
