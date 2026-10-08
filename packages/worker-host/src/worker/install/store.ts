// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Where a mount that outlives the Worker keeps each version's data, apart
// from the engine's own files: an IndexedDB database, or a directory on the
// host, per version. A version's data is installed into storage emptied
// first, and its marker is written last, so that data with a marker is
// whole and the version's alone. Once marked, the data is read-only to the
// engine where the backend can refuse changes, as the IndexedDB backend
// can; the Node backend has no read-only mode, so there the engine is
// trusted not to write its data.

import { encodeComponent, engineDataDatabase, engineDataDatabasePrefix } from "../../shared/naming.ts";
import type { EngineManifest } from "@ibus-web/protocol";
import { nodeFs } from "../node-fs.ts";
import { withString, type RuntimeHandle } from "../runtime.ts";
import { openExisting } from "../storage/plan.ts";

// The marker of a version's data installed whole: the regular files and
// bytes of file data its install wrote.
interface Marker {
  version: string;
  files: number;
  bytes: number;
}

// The marker, if value is one for version; anything else counts as none.
const markerOf = (value: unknown, version: string): Marker | null => {
  if (typeof value !== "object" || value === null) return null;
  const { version: marked, files, bytes } = value as Partial<Record<keyof Marker, unknown>>;
  return marked === version && typeof files === "number" && typeof bytes === "number"
    ? { version, files, bytes }
    : null;
};

export interface DataStore {
  // This version's marker, or null. It is read before the data is mounted,
  // so that a store about to be emptied has no connection of this host's
  // open.
  installed(): Promise<Marker | null>;
  // Empties this version's storage.
  clear(): Promise<void>;
  // A backend over this version's storage, or 0. The Node backend has no
  // read-only mode.
  backend(readOnly: boolean): number;
  // Marks this version's data installed, durably, once the data is.
  mark(marker: Marker): Promise<void>;
  // Makes a read-write backend refuse every later change, where it can.
  readonly seal?: () => void;
  // Every other version whose data is kept, encoded.
  others(): Promise<string[]>;
  remove(version: string): Promise<void>;
  // Whether the backend's connection has closed under it.
  closed(): boolean;
}

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

// The key of the marker in the database's meta store. The store is the
// backend's, which reads only its own keys.
const MARKER_KEY = "installed";

const idbRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export const idbStore = (
  handle: RuntimeHandle,
  engine: EngineManifest,
  readOnlyFlag: number,
  deleteLimitMs: number,
): DataStore => {
  const { rt } = handle;
  const database = engineDataDatabase(engine);
  const prefix = engineDataDatabasePrefix(engine);
  let backend = 0;
  return {
    async installed() {
      const db = await openExisting(database);
      if (db === null) return null;
      try {
        if (!db.objectStoreNames.contains("meta")) return null;
        return markerOf(
          await idbRequest(db.transaction("meta", "readonly").objectStore("meta").get(MARKER_KEY)),
          engine.version,
        );
      } finally {
        db.close();
      }
    },
    clear: () => deleteDatabase(database, deleteLimitMs),
    backend(readOnly) {
      backend = withString(handle, database, (ptr) => rt._wasmfs_create_idb_backend(ptr, readOnly ? readOnlyFlag : 0));
      return backend;
    },
    // Every file was fsync()ed, so the data is committed. The directory
    // entries made after a file's last fsync() were committed relaxed; this
    // commit's strict durability flushes them too, since a strict commit
    // makes every earlier change to the database durable. The connection is
    // the host's own, apart from the backend's.
    async mark(marker) {
      const db = await openExisting(database);
      if (db === null) throw new Error(`${database} is gone`);
      try {
        const tx = db.transaction("meta", "readwrite", { durability: "strict" });
        const committed = new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error ?? new Error(`marking ${database} aborted`));
        });
        tx.objectStore("meta").put(marker, MARKER_KEY);
        await committed;
      } finally {
        db.close();
      }
    },
    seal: () => {
      if (backend !== 0) rt._wasmfs_idb_backend_seal(backend);
    },
    async others() {
      return (await indexedDB.databases())
        .map(({ name }) => name ?? "")
        .filter((name) => name.startsWith(prefix))
        .map((name) => name.slice(prefix.length))
        .filter((version) => version !== "" && !version.includes("/") && `${prefix}${version}` !== database);
    },
    remove: (version) => deleteDatabase(`${prefix}${version}`, deleteLimitMs),
    closed: () => backend !== 0 && rt._wasmfs_idb_backend_closed(backend) !== 0,
  };
};

// Each version's data is a directory under data/ beside the engine's own
// files; its marker is a file beside that directory, outside the tree the
// engine sees, written whole as <version>.marking, then renamed over
// <version>.installed.
const MARKER = ".installed";
const PENDING = ".marking";

export const nodeStore = async (
  handle: RuntimeHandle,
  engine: EngineManifest,
  hostPath: string,
): Promise<DataStore> => {
  const fs = await nodeFs();
  const root = `${hostPath}/data`;
  const own = encodeComponent(engine.version);
  const dirOf = (version: string): string => `${root}/${version}`;
  const markerPath = (version: string): string => `${dirOf(version)}${MARKER}`;
  const pendingPath = (version: string): string => `${dirOf(version)}${PENDING}`;
  // The marker goes first, so that a removal cut short leaves no marker.
  const remove = async (version: string): Promise<void> => {
    for (const path of [markerPath(version), pendingPath(version), dirOf(version)])
      await fs.rm(path, { recursive: true, force: true });
  };
  return {
    // A marker that doesn't parse is none, so the version is installed
    // again rather than every start failing.
    async installed() {
      try {
        return markerOf(JSON.parse(await fs.readFile(markerPath(own), "utf8")), engine.version);
      } catch {
        return null;
      }
    },
    async clear() {
      await remove(own);
      await fs.mkdir(dirOf(own), { recursive: true });
    },
    backend: () => withString(handle, dirOf(own), (ptr) => handle.rt._wasmfs_create_node_backend(ptr)),
    // Every file of the data was fsync()ed before this is written. The
    // rename makes the marker whole or absent, and syncing the directory,
    // where the platform allows it, makes the rename durable.
    async mark(marker) {
      const file = await fs.open(pendingPath(own), "w");
      try {
        await file.writeFile(JSON.stringify(marker));
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(pendingPath(own), markerPath(own));
      try {
        const dir = await fs.open(root, "r");
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      } catch {
        // Some platforms can't open a directory to sync it.
      }
    },
    // A version's directory, its marker, its marker being written, or any
    // of them together.
    others: async () => [
      ...new Set(
        (await fs.readdir(root).catch(() => [] as string[]))
          .map((name) => name.replace(/\.(installed|marking)$/, ""))
          .filter((version) => version !== own),
      ),
    ],
    remove,
    closed: () => false,
  };
};
