// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Appended to the errors test's module, which runs it on every thread. On
// the program's main thread it keeps what the module prints to stderr,
// where a host hears from the backend's thread, and it gives the test a
// connection of its own that asks for a newer version of a database, as a
// later version of the backend would.

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
 * Opens `name` at version 2 and closes it again. `done` gets 1 once that
 * has happened, 2 as soon as the open is blocked by a connection that stays
 * open, and 0 if it fails.
 * @param {string} name
 * @param {(outcome: number) => void} done
 */
const wasmfsIdbTestUpgrade = (name, done) => {
  let settled = false;
  /** @param {number} outcome */
  const settle = (outcome) => {
    if (!settled) done(outcome);
    settled = true;
  };
  const request = indexedDB.open(name, 2);
  request.onblocked = () => settle(2);
  request.onerror = () => settle(0);
  request.onsuccess = () => {
    request.result.close();
    settle(1);
  };
};

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
