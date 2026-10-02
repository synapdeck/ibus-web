// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Appended to a test's module, which runs it on every thread. On the
// program's main thread it keeps what the module prints to stderr, where a
// host hears from the backend's thread, for the test to wait for a line.

/** @type {string[]} */
const wasmfsIdbTestStderr = [];

if (!ENVIRONMENT_IS_PTHREAD) {
  // Other threads print through the main thread's handler by its name.
  const printErr = Module["printErr"];
  Module["printErr"] = (text) => {
    wasmfsIdbTestStderr.push(text);
    printErr?.(text);
  };
}

/**
 * Calls `done` with 1 once stderr has had a line holding `text`, or with 0
 * if none comes in 5 seconds. A line from another thread arrives as a
 * message, in no fixed order with IndexedDB's events.
 * @param {string} text
 * @param {(found: number) => void} done
 */
const wasmfsIdbTestAwaitStderr = (text, done) => {
  const deadline = performance.now() + 5000;
  const poll = () => {
    if (wasmfsIdbTestStderr.some((line) => line.includes(text))) done(1);
    else if (performance.now() > deadline) done(0);
    else setTimeout(poll, 10);
  };
  poll();
};
