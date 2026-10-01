// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The browser experiments' commands to their Workers, and the steps the
// nested-Worker experiment marks.

export type ExperimentCommand =
  // Creates file at the root of the origin's private file system, or
  // overwrites it, through a sync access handle it then closes.
  | { op: "create"; file: string }
  // Opens a sync access handle on file, passing mode as Chromium's mode
  // option if given, and keeps it; returns its id.
  | { op: "open"; file: string; mode?: string }
  | { op: "write"; handle: number }
  | { op: "close"; handle: number }
  // Reads file through getFile() and Blob.arrayBuffer(); returns its size.
  | { op: "read-blob"; file: string }
  // Opens a writable stream on file and closes it.
  | { op: "create-writable"; file: string }
  // The nested-Worker experiment. A starts B, which creates the file it
  // reads; then go starts the steps, A blocking for blockMs.
  | { op: "nested-a"; marks: SharedArrayBuffer }
  | { op: "nested-b"; marks: SharedArrayBuffer }
  | { op: "nested-go"; epoch: number; blockMs: number }
  | {
      op: "nested-child";
      marks: SharedArrayBuffer;
      epoch: number;
      mark: number;
    };

// Indices into the nested experiment's marks.
export const NestedMark = {
  aNewWorkerC: 0,
  cStarts: 1,
  aUnblocked: 2,
  bGetDirectory: 3,
  bGetFileHandlePresent: 4,
  bGetFileHandleAbsent: 5,
  bSyncWriteFlushClose: 6,
  bGetFile: 7,
  bArrayBuffer: 8,
  bNewWorkerD: 9,
  dStarts: 10,
} as const;

export const nestedLabels: Readonly<Record<keyof typeof NestedMark, string>> = {
  aNewWorkerC: "A: new Worker(C) returns",
  cStarts: "C starts",
  aUnblocked: "A: unblocked",
  bGetDirectory: "B: getDirectory()",
  bGetFileHandlePresent: "B: getFileHandle(), present",
  bGetFileHandleAbsent: "B: getFileHandle(), absent",
  bSyncWriteFlushClose:
    "B: sync access handle created, written, flushed, closed",
  bGetFile: "B: getFile()",
  bArrayBuffer: "B: File.arrayBuffer()",
  bNewWorkerD: "B: new Worker(D) returns",
  dStarts: "D starts",
};

// Marks not yet written.
export const UNMARKED = -1;
