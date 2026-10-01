// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The page side of the browser experiments: Workers that experiment
// commands drive, by name, and the nested-Worker experiment, with the page's
// thread free or spinning.

import {
  NestedMark,
  UNMARKED,
  type ExperimentCommand,
} from "../shared/experiments.ts";

const workerUrl = new URL("../worker/experiment.js", import.meta.url);
const workers = new Map<string, Worker>();
let nextId = 1;

const start = (name: string): Worker => {
  const worker = new Worker(workerUrl, { type: "module", name });
  workers.set(name, worker);
  return worker;
};

// Resolves with the command's result, or { error } with the name of what it
// threw.
const send = (
  worker: Worker,
  command: ExperimentCommand,
): Promise<{ result?: unknown; error?: string }> => {
  const id = nextId++;
  return new Promise((resolve) => {
    const listener = ({
      data,
    }: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      if (data.id !== id) return;
      worker.removeEventListener("message", listener);
      resolve(data);
    };
    worker.addEventListener("message", listener);
    worker.postMessage({ id, command });
  });
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Milliseconds after go that each step ended, or null if it hadn't by the
// end. A blocks for blockMs; with spin, the page's thread spins as long.
const nested = async (
  spin: boolean,
  blockMs: number,
): Promise<Record<string, number | null>> => {
  const marks = new Int32Array(
    new SharedArrayBuffer(Object.keys(NestedMark).length * 4),
  ).fill(UNMARKED);
  const a = start("A");
  const setup = await send(a, {
    op: "nested-a",
    marks: marks.buffer as SharedArrayBuffer,
  });
  if (setup.error !== undefined) throw new Error(`setup: ${setup.error}`);
  const epoch = performance.timeOrigin + performance.now();
  const done = send(a, { op: "nested-go", epoch, blockMs });
  if (spin) {
    const until = performance.now() + blockMs;
    while (performance.now() < until);
  }
  await done;
  await sleep(1000);
  return Object.fromEntries(
    Object.entries(NestedMark).map(([step, index]) => {
      const us = Atomics.load(marks, index);
      return [step, us === UNMARKED ? null : us / 1000];
    }),
  );
};

const experiments = {
  start: (name: string): void => {
    start(name);
  },
  send: (name: string, command: ExperimentCommand) =>
    send(workers.get(name)!, command),
  nested,
  terminate: (): void => {
    for (const worker of workers.values()) worker.terminate();
    workers.clear();
  },
};

export type Experiments = typeof experiments;

Object.assign(globalThis, { experiments });
