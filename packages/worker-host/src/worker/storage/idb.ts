// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// IndexedDB calls made outside the WasmFS backends, each on a short
// connection of its own.

export const idbRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

// Opens the database if it exists, without creating it: opening a database
// that doesn't exist would create it, empty, at the version the backend
// creates its object stores in, so that creation is aborted, which leaves
// nothing behind. Resolves with the connection, or null if there is no
// such database; a connection closes when another asks for a version
// change, so that it never holds one up.
export const openExisting = (database: string): Promise<IDBDatabase | null> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(database);
    let creating = false;
    request.onupgradeneeded = () => {
      creating = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = (event) => {
      event.preventDefault();
      if (creating && request.error?.name === "AbortError") resolve(null);
      else reject(request.error ?? new Error(`opening ${database} failed`));
    };
  });

// Deletes the database, failing if another connection to it stays open
// past limitMs after it was asked to close. Every connection the runtime
// and the host make closes when asked, so only one that doesn't holds a
// deletion up.
export const deleteDatabase = (name: string, limitMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve();
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error ?? new Error(`deleting ${name} failed`));
    };
    request.onblocked = () => {
      timer ??= setTimeout(
        () =>
          reject(
            new Error(
              `deleting ${name}: another connection to it stayed open for ${limitMs} ms after it was asked to close`,
            ),
          ),
        limitMs,
      );
    };
  });
