// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the host mounts at the engine's directory, decided before the
// runtime's memory is made, since a mount in memory needs a larger one.

import { errorSummary, type EngineManifest } from "@ibus-web/protocol";
import { memoryWithData, type EngineStorage, type RuntimeMemory } from "../../shared/messages.ts";
import { engineDatabase, engineWriterLock } from "../../shared/naming.ts";
import type { Held } from "./held.ts";
import { requestLock } from "./locks.ts";

// readOnly: another host holds the engine's writer lock.
export type StoragePlan =
  | { mount: "none" }
  | { mount: "node"; hostPath: string; readOnly: boolean }
  | { mount: "indexeddb"; database: string; flags: number; readOnly: boolean }
  // why: IndexedDB can't be opened.
  | { mount: "memory"; why: string };

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

// Whether IndexedDB opens the database: null if it does, or why not. The
// backend opens its own connection, on its own thread, so this one closes
// at once.
const probeIndexedDB = async (database: string): Promise<string | null> => {
  if ((globalThis as { indexedDB?: IDBFactory }).indexedDB === undefined) return "this environment has no IndexedDB";
  try {
    (await openExisting(database))?.close();
    return null;
  } catch (error) {
    return errorSummary(error);
  }
};

// Whether this host is the one that may change the engine's user data: it
// is if it gets the engine's writer lock at once, and then holds it for as
// long as it runs. Hosts don't queue for it: one that starts while another
// writes stays read-only for good, since a backend can't become writable.
const takeWriterLock = async (engine: EngineManifest, held: Held): Promise<boolean> => {
  const lock = await requestLock(engineWriterLock(engine), {
    mode: "exclusive",
    ifAvailable: true,
  });
  if (lock === null) return false;
  held.addWriter(lock);
  return true;
};

export const planStorage = async (
  storage: EngineStorage,
  engine: EngineManifest,
  readOnlyFlag: number,
  held: Held,
): Promise<StoragePlan> => {
  switch (storage.kind) {
    case "none":
      return { mount: "none" };
    case "node":
      return {
        mount: "node",
        hostPath: storage.hostPath,
        readOnly: !(await takeWriterLock(engine, held)),
      };
    case "browser": {
      const database = engineDatabase(engine);
      const why = await probeIndexedDB(database);
      if (why !== null) return { mount: "memory", why };
      // The flags are decided before the backend exists because creating it
      // read-write sweeps the database of what a crash left behind, which
      // only the database's one writer may do.
      const readOnly = !(await takeWriterLock(engine, held));
      return {
        mount: "indexeddb",
        database,
        flags: readOnly ? readOnlyFlag : 0,
        readOnly,
      };
    }
  }
};

// Both the browser fallback and the default filesystem used without user
// storage keep the engine's data in runtime memory.
export const memoryFor = (memory: RuntimeMemory, plan: StoragePlan, engine: EngineManifest): RuntimeMemory =>
  plan.mount === "memory" || plan.mount === "none" ? memoryWithData(memory, engine) : memory;
