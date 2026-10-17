// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A module's host closes its connections to the module's databases when
// another asks to change their version, but closing wakes nothing: a host
// asleep with nothing due would report it only when it next woke for
// something else. So the page keeps a connection of its own to each, on
// which it never opens a transaction, only to hear the same request.

// Opens the database if it exists, never creating one, and calls changed at
// its first versionchange, closing at once so as not to hold the change up.
const watchDatabase = (name: string, changed: () => void): (() => void) => {
  let db: IDBDatabase | undefined;
  let stopped = false;
  const request = indexedDB.open(name);
  // Opening a database that doesn't exist would create it, empty, at version
  // 1, which the module's host would then find without its stores.
  request.onupgradeneeded = () => request.transaction?.abort();
  request.onerror = (event) => event.preventDefault();
  request.onsuccess = () => {
    const opened = request.result;
    if (stopped) {
      opened.close();
      return;
    }
    db = opened;
    opened.onversionchange = () => {
      opened.close();
      db = undefined;
      changed();
    };
  };
  return () => {
    stopped = true;
    db?.close();
    db = undefined;
  };
};

/** Calls changed whenever one of the databases is asked to change its version, until the returned stop is called. */
export const watchDatabases = (names: readonly string[], changed: () => void): (() => void) => {
  if (typeof indexedDB === "undefined") return () => {};
  const stops = names.map((name) => watchDatabase(name, changed));
  return () => {
    for (const stop of stops) stop();
  };
};
