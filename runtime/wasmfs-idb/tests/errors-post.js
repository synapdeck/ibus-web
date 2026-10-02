// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Appended to the errors test's module, which runs it on every thread. It
// gives the test a connection of its own that asks for a newer version of a
// database, as a later version of the backend would.

/**
 * Opens `name` at version 2 and closes it again. `done` gets 1 once that
 * has happened, 2 as soon as the open is blocked by a connection that stays
 * open, and 0 if it fails.
 * @param {string} name
 * @param {(outcome: number) => void} done
 */
// oxlint-disable-next-line no-unused-vars -- the test's EM_ASM calls it.
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
