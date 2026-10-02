// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A Worker for the browser experiments, which need no runtime: each message
// is a command, answered with { id, result } or { id, error }, the name of
// what the command threw.
//
// The nested-Worker experiment's Workers mark when each of their steps ends
// in a shared Int32Array, in microseconds after an epoch the page sets: A
// starts B, then, once the page says go, creates C and blocks for a while,
// while B, a child of A, runs OPFS calls and creates D.

import { NestedMark, type ExperimentCommand } from "../shared/experiments.ts";
import { runStorage } from "./storage.ts";

// Before any message: when this Worker's script ran.
const loadedAt = performance.timeOrigin + performance.now();

const workerUrl = new URL(import.meta.url);

const handles = new Map<number, FileSystemSyncAccessHandle>();
let nextHandle = 1;

// Chromium's non-standard mode option; other engines ignore what they don't
// know.
type SyncAccessHandleOptions = { mode?: string };

const fileHandle = async (
  name: string,
  create = false,
): Promise<FileSystemFileHandle> =>
  (await navigator.storage.getDirectory()).getFileHandle(name, { create });

let marks: Int32Array | null = null;
let epoch = 0;
const mark = (
  step: number,
  at = performance.timeOrigin + performance.now(),
) => {
  if (marks !== null)
    Atomics.store(marks, step, Math.round((at - epoch) * 1000));
};

// The nested experiment's children, by role.
const children = new Map<string, Worker>();

const spawn = (name: string): Worker =>
  new Worker(workerUrl, { type: "module", name });

// Sends a child a command and waits for its answer.
const ask = (worker: Worker, command: ExperimentCommand): Promise<unknown> =>
  new Promise((resolve, reject) => {
    worker.onmessage = ({
      data,
    }: MessageEvent<{ result?: unknown; error?: string }>) =>
      data.error === undefined
        ? resolve(data.result)
        : reject(new Error(data.error));
    worker.postMessage({ id: 0, command });
  });

const run = async (command: ExperimentCommand): Promise<unknown> => {
  switch (command.op) {
    case "create": {
      const handle = await (
        await fileHandle(command.file, true)
      ).createSyncAccessHandle();
      handle.write(new TextEncoder().encode(command.file), { at: 0 });
      handle.close();
      return null;
    }
    case "open": {
      const file = await fileHandle(command.file);
      const options: SyncAccessHandleOptions =
        command.mode === undefined ? {} : { mode: command.mode };
      const handle = await (
        file.createSyncAccessHandle as (
          options: SyncAccessHandleOptions,
        ) => Promise<FileSystemSyncAccessHandle>
      ).call(file, options);
      const id = nextHandle++;
      handles.set(id, handle);
      return id;
    }
    case "write":
      return handles
        .get(command.handle)!
        .write(new Uint8Array([0x21]), { at: 0 });
    case "close":
      handles.get(command.handle)!.close();
      handles.delete(command.handle);
      return null;
    case "read-blob":
      return (
        await (await (await fileHandle(command.file)).getFile()).arrayBuffer()
      ).byteLength;
    case "create-writable": {
      const stream = await (
        await fileHandle(command.file)
      ).createWritable({
        keepExistingData: true,
      });
      await stream.close();
      return null;
    }
    case "nested-a": {
      marks = new Int32Array(command.marks);
      const b = spawn("B");
      children.set("B", b);
      await ask(b, { op: "nested-b", marks: command.marks });
      return null;
    }
    case "nested-b":
      marks = new Int32Array(command.marks);
      await run({ op: "create", file: "nested-present.txt" });
      return null;
    case "nested-go": {
      epoch = command.epoch;
      if (children.has("B")) {
        // A: B runs its steps meanwhile.
        children.get("B")!.postMessage({ id: 0, command });
        const c = spawn("C");
        mark(NestedMark.aNewWorkerC);
        c.postMessage({
          id: 0,
          command: {
            op: "nested-child",
            marks: marks!.buffer,
            epoch,
            mark: NestedMark.cStarts,
          },
        });
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          command.blockMs,
        );
        mark(NestedMark.aUnblocked);
        return null;
      }
      const root = await navigator.storage.getDirectory();
      mark(NestedMark.bGetDirectory);
      const present = await root.getFileHandle("nested-present.txt");
      mark(NestedMark.bGetFileHandlePresent);
      try {
        await root.getFileHandle("nested-absent.txt");
      } catch {
        // NotFoundError, as expected.
      }
      mark(NestedMark.bGetFileHandleAbsent);
      const access = await present.createSyncAccessHandle();
      access.write(new Uint8Array([0x21]), { at: 0 });
      access.flush();
      access.close();
      mark(NestedMark.bSyncWriteFlushClose);
      const blob = await present.getFile();
      mark(NestedMark.bGetFile);
      await blob.arrayBuffer();
      mark(NestedMark.bArrayBuffer);
      const d = spawn("D");
      mark(NestedMark.bNewWorkerD);
      d.postMessage({
        id: 0,
        command: {
          op: "nested-child",
          marks: marks!.buffer,
          epoch,
          mark: NestedMark.dStarts,
        },
      });
      return null;
    }
    case "nested-child":
      marks = new Int32Array(command.marks);
      epoch = command.epoch;
      mark(command.mark, loadedAt);
      return null;
    default:
      return runStorage(command);
  }
};

self.onmessage = ({
  data,
}: MessageEvent<{ id: number; command: ExperimentCommand }>) => {
  run(data.command).then(
    (result) => self.postMessage({ id: data.id, result }),
    (error: unknown) =>
      self.postMessage({
        id: data.id,
        error:
          error instanceof DOMException || error instanceof Error
            ? error.name
            : String(error),
      }),
  );
};
