// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Starting the Worker host under Node, with the Node harnesses playing the
// page, and the build's files they load.

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { startHost as bootHost } from "../shared/bootstrap.ts";
import { blockingClient } from "../shared/client.ts";
import {
  createControl,
  type BuildConstants,
  type HostFeatures,
  type HostInit,
  type HostMessage,
  type SideModule,
  type WaitMode,
} from "../shared/control.ts";
import type { Client } from "../shared/scenarios.ts";
import { BrowserWorker } from "./worker-adapter.ts";

// Node's types leave WebAssembly to the DOM library, which Node code here
// doesn't load; this is the one call made, and the module only passes
// through to the host.
declare const WebAssembly: { compile(bytes: Uint8Array): Promise<object> };

const REPLY_TIMEOUT_MS = 30_000;

export interface NodeHost {
  worker: BrowserWorker;
  client: Client;
  startupMs: number;
  features: HostFeatures;
  // Messages after "ready", such as a crash report.
  messages: HostMessage[];
}

// Starts a host, whose messages go to messages as they arrive; host
// settles once it is ready, or rejects with why it didn't start.
export const launchNodeHost = (
  wait: WaitMode,
  base: Omit<HostInit<object>, "control" | "wait">,
  messages: HostMessage[] = [],
): { worker: BrowserWorker; host: Promise<NodeHost> } => {
  const control = createControl();
  const worker = new BrowserWorker(new URL("../worker/host.js", import.meta.url));
  const init: HostInit<object> = { ...base, control, wait };
  const host = bootHost(worker, init, messages).then(({ startupMs, features }) => ({
    worker,
    // Blocks this thread until the host replies, as the page's
    // synchronous keystroke path would spin.
    client: blockingClient(control, messages, {
      now: () => performance.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      block: (words, index, value, ms) => {
        Atomics.wait(words, index, value, ms);
      },
      replyTimeoutMs: REPLY_TIMEOUT_MS,
    }),
    startupMs,
    features,
    messages,
  }));
  return { worker, host };
};

export const startNodeHost = (wait: WaitMode, base: Omit<HostInit<object>, "control" | "wait">): Promise<NodeHost> =>
  launchNodeHost(wait, base).host;

export const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;

export const readConstants = (path: string): Promise<BuildConstants> => readJson<BuildConstants>(path);

// The runtime's ibus-runtime.wasm, beside its JavaScript, compiled.
export const compileRuntime = async (runtimeJs: string): Promise<object> =>
  WebAssembly.compile(await readFile(join(runtimeJs, "..", "ibus-runtime.wasm")));

// Every side module in dir, by name.
export const readSides = async (dir: string): Promise<SideModule[]> =>
  Promise.all(
    (await readdir(dir))
      .filter((file) => file.endsWith(".wasm"))
      .sort()
      .map(async (file) => {
        const bytes = await readFile(join(dir, file));
        return {
          name: basename(file, ".wasm"),
          bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        };
      }),
  );
