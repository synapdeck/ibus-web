// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Imported into each program's Node before the program, to make its stdout
// and stderr pipes blocking. Emscripten writes a program's output with
// fs.writeSync, which waits for a slow reader only on a blocking pipe. Node
// makes a pipe non-blocking once process.stdout or process.stderr opens a
// stream on it, which starting a pthread's Worker does to forward the
// Worker's output; a write the reader hasn't made room for then comes up
// short, dropping the rest of the line, or fails with EAGAIN.

import process from "node:process";
import { isMainThread } from "node:worker_threads";

// The undocumented libuv handle under a net.Socket or tty.WriteStream.
interface StdioHandle {
  setBlocking?(blocking: boolean): number;
}

if (isMainThread) {
  for (const stream of [process.stdout, process.stderr]) {
    // A file's stream has no handle: Node writes files synchronously.
    const handle = (stream as unknown as { _handle?: StdioHandle })._handle;
    if (handle === undefined) continue;
    const status = handle.setBlocking?.(true);
    if (status !== 0) throw new Error(`couldn't make fd ${stream.fd} blocking: ${status ?? "no setBlocking"}`);
  }
}
