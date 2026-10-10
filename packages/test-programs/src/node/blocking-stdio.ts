// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Imported into each program's Node before the program, to make its stdout
// and stderr pipes blocking. Emscripten writes a program's output with
// fs.writeSync, which waits for a slow reader only on a blocking pipe. Node
// makes a pipe non-blocking once process.stdout or process.stderr opens a
// stream on it, which constructing a pthread's Worker does to forward the
// Worker's stdio, whether or not it ever prints; a write the reader hasn't
// made room for then comes up short, dropping the rest of the line, or fails
// with EAGAIN.

import { fstatSync } from "node:fs";
import process from "node:process";
import { isMainThread } from "node:worker_threads";

// The undocumented libuv handle under a net.Socket.
interface StdioHandle {
  setBlocking?(blocking: boolean): number;
}

// Every pthread's Worker inherits the --import through execArgv, and a
// Worker's stdio is a stream over its message port, with no fd to change.
if (isMainThread) {
  for (const [fd, stream] of [
    [1, process.stdout],
    [2, process.stderr],
  ] as const) {
    // Only a pipe or a socket turns non-blocking: Node writes files
    // synchronously and keeps a terminal blocking itself.
    const stat = fstatSync(fd);
    if (!stat.isFIFO() && !stat.isSocket()) continue;

    const handle = (stream as unknown as { _handle?: StdioHandle })._handle;
    if (handle?.setBlocking === undefined) throw new Error(`fd ${fd} is a pipe, but its stream has no setBlocking`);
    const status = handle.setBlocking(true);
    if (status !== 0) throw new Error(`couldn't make fd ${fd} blocking: ${status}`);
  }
}
