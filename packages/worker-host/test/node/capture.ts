// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Loaded first in every Worker a test starts. Emscripten under Node prints
// with fs.writeSync() on file descriptors 1 and 2, straight to the process's
// own output, which the test couldn't see. A thread's process.stdout would
// reach the test only through the thread's event loop, which a host asleep
// in the runtime doesn't run; so the writes go, as synchronously, to the
// file IBUS_WEB_WORKER_HOST_OUTPUT names, which the test reads.

import fs from "node:fs";
import process from "node:process";

const path = process.env["IBUS_WEB_WORKER_HOST_OUTPUT"];
if (path !== undefined) {
  const output = fs.openSync(path, "a");
  const writeSync = fs.writeSync;
  fs.writeSync = ((fd: unknown, data: unknown, ...rest: unknown[]): number => {
    if ((fd !== 1 && fd !== 2) || typeof data !== "string") return Reflect.apply(writeSync, fs, [fd, data, ...rest]);
    writeSync(output, data);
    return Buffer.byteLength(data);
  }) as typeof fs.writeSync;
}
