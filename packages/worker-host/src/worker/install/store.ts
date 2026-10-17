// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Where a mount that outlives the Worker keeps each version's data, apart
// from the engine's own files: an IndexedDB database, or a directory on the
// host, per version. A version's base data is installed into storage
// emptied first, and its marker is written last, so that data with a marker
// is whole and the version's alone. Each store path of an engine's own data
// is installed later into the same storage, with a marker of its own written
// last. The data is read-only to the engine but while an install holds the
// backend's window open, where the backend can refuse changes, as the
// IndexedDB backend can; the Node backend has no read-only mode, so there
// the engine is trusted not to write its data.

import {
  encodeComponent,
  engineDataDatabase,
  engineDataDatabasePrefix,
  enginePathMarker,
} from "../../shared/naming.ts";
import type { ModuleManifest } from "@ibus-web/protocol";
import { nodeFs } from "../node-fs.ts";
import { check, RuntimeRefused, withString, type RuntimeHandle } from "../runtime.ts";
import { deleteDatabase, idbRequest, openExisting } from "../storage/idb.ts";

// The marker of a version's data installed whole: the regular files and
// bytes of file data its install wrote.
interface Marker {
  version: string;
  files: number;
  bytes: number;
}

// The marker of one store path of an engine's own data, installed whole:
// the regular files and bytes of file data its install wrote. The storage
// is the version's own, so the marker needs no version.
export interface PathMarker {
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

const pathMarkerOf = (value: unknown): PathMarker | null => {
  if (typeof value !== "object" || value === null) return null;
  const { files, bytes } = value as Partial<Record<keyof PathMarker, unknown>>;
  return typeof files === "number" && typeof bytes === "number" ? { files, bytes } : null;
};

export interface DataStore {
  // This version's marker, or null. It is read before the data is mounted,
  // so that a store about to be emptied has no connection of this host's
  // open.
  installed(): Promise<Marker | null>;
  // Empties this version's storage.
  clear(): Promise<void>;
  // A backend over this version's storage, its window for changes shut, or
  // 0. The Node backend has no read-only mode.
  backend(): number;
  // Opens or shuts the backend's window for changes, where it has one.
  setWritable(writable: boolean): void;
  // Marks this version's base data installed, durably, once the data is.
  mark(marker: Marker): Promise<void>;
  // The marker of a store path of an engine's own data, or null.
  pathInstalled(storePath: string): Promise<PathMarker | null>;
  // Marks the store path installed, durably, once its data is.
  markPath(storePath: string, marker: PathMarker): Promise<void>;
  // Makes the backend refuse every later change for good, where it can.
  readonly seal?: () => void;
  // Every other version whose data is kept, encoded.
  others(): Promise<string[]>;
  remove(version: string): Promise<void>;
  // Whether the backend's connection has closed under it.
  closed(): boolean;
  // How many changes through the backend have failed for want of space.
  quotaFailures(): number;
  // While the host has a transaction of its own open on this version's
  // storage, a promise that settles once it has none; otherwise undefined.
  quiet(): Promise<void> | undefined;
}

// Runs installs with the backend's window open: it opens as the first of
// any that overlap starts and shuts as the last ends, so installs of
// different store paths can run at once. An install that threw from inside
// the runtime leaves it unfit to call, so nothing shuts the window after
// one. changed hears each opening and shutting.
export const sharedWindow = (
  store: DataStore,
  changed: (open: boolean) => void = () => {},
): (<T>(install: () => Promise<T>) => Promise<T>) => {
  let running = 0;
  const shut = (): void => {
    store.setWritable(false);
    changed(false);
  };
  return async (install) => {
    if (running++ === 0) {
      store.setWritable(true);
      changed(true);
    }
    try {
      const result = await install();
      if (--running === 0) shut();
      return result;
    } catch (error) {
      if (--running === 0 && error instanceof RuntimeRefused) shut();
      throw error;
    }
  };
};

// The key of the marker in the database's meta store. The store is the
// backend's, which reads only its own keys.
const MARKER_KEY = "installed";

// Puts value at key in the database's meta store, on a connection of the
// host's own, apart from the backend's. Every file was fsync()ed, so the
// data is committed. The directory entries made after a file's last
// fsync() were committed relaxed; this commit's strict durability flushes
// them too, since a strict commit makes every earlier change to the
// database durable.
const putMeta = async (database: string, key: string, value: unknown): Promise<void> => {
  const db = await openExisting(database);
  if (db === null) throw new Error(`${database} is gone`);
  try {
    const tx = db.transaction("meta", "readwrite", { durability: "strict" });
    const committed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error(`marking ${database} aborted`));
    });
    tx.objectStore("meta").put(value, key);
    await committed;
  } finally {
    db.close();
  }
};

// The value at key in the database's meta store, or undefined if there is
// no such database or store.
const getMeta = async (database: string, key: string): Promise<unknown> => {
  const db = await openExisting(database);
  if (db === null) return undefined;
  try {
    if (!db.objectStoreNames.contains("meta")) return undefined;
    return await idbRequest(db.transaction("meta", "readonly").objectStore("meta").get(key));
  } finally {
    db.close();
  }
};

export const idbStore = (
  handle: RuntimeHandle,
  engine: ModuleManifest,
  readOnlyFlag: number,
  deleteLimitMs: number,
): DataStore => {
  const { rt } = handle;
  const database = engineDataDatabase(engine);
  const prefix = engineDataDatabasePrefix(engine);
  let backend = 0;
  // The host's own connections open on the database, and who waits for
  // there to be none.
  let open = 0;
  let quieted: Promise<void> | undefined;
  let quiet: (() => void) | undefined;
  const tracked = async <T>(work: () => Promise<T>): Promise<T> => {
    if (open++ === 0) quieted = new Promise((resolve) => (quiet = resolve));
    try {
      return await work();
    } finally {
      if (--open === 0) {
        quieted = undefined;
        quiet?.();
      }
    }
  };
  return {
    installed: async () => markerOf(await getMeta(database, MARKER_KEY), engine.version),
    clear: () => deleteDatabase(database, deleteLimitMs),
    // Created read-only, the backend neither sweeps the database, which
    // hosts installing other store paths write, nor takes a change until an
    // install opens its window.
    backend() {
      backend = withString(handle, database, (ptr) => rt._wasmfs_create_idb_backend(ptr, readOnlyFlag));
      return backend;
    },
    setWritable: (writable) =>
      check(
        `${writable ? "opening" : "shutting"} ${database}'s window`,
        rt._wasmfs_idb_backend_set_writable(backend, writable ? 1 : 0),
      ),
    mark: (marker) => tracked(() => putMeta(database, MARKER_KEY, marker)),
    pathInstalled: async (storePath) =>
      pathMarkerOf(await tracked(() => getMeta(database, enginePathMarker(storePath)))),
    markPath: (storePath, marker) => tracked(() => putMeta(database, enginePathMarker(storePath), marker)),
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
    quotaFailures: () => (backend === 0 ? 0 : rt._wasmfs_idb_backend_quota_failures(backend) >>> 0),
    quiet: () => quieted,
  };
};

// Each version's data is a directory under data/ beside the engine's own
// files; its marker is a file beside that directory, outside the tree the
// engine sees, written whole as <version>.marking, then renamed over
// <version>.installed. The markers of the store paths of engines' own data
// are files in <version>.paths/ beside it, each named for its store path,
// written the same way.
const MARKER = ".installed";
const PENDING = ".marking";
const PATHS = ".paths";

// Writes value as JSON to path whole or not at all: to pending, synced,
// renamed over path, and the directory synced after where the platform
// allows it, which makes the rename durable.
const writeWhole = async (
  fs: Awaited<ReturnType<typeof nodeFs>>,
  dir: string,
  pending: string,
  path: string,
  value: unknown,
): Promise<void> => {
  const file = await fs.open(pending, "w");
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await fs.rename(pending, path);
  try {
    const handle = await fs.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms can't open a directory to sync it.
  }
};

export const nodeStore = async (
  handle: RuntimeHandle,
  engine: ModuleManifest,
  hostPath: string,
): Promise<DataStore> => {
  const fs = await nodeFs();
  const root = `${hostPath}/data`;
  const own = encodeComponent(engine.version);
  const dirOf = (version: string): string => `${root}/${version}`;
  const markerPath = (version: string): string => `${dirOf(version)}${MARKER}`;
  const pendingPath = (version: string): string => `${dirOf(version)}${PENDING}`;
  const pathsDir = (version: string): string => `${dirOf(version)}${PATHS}`;
  const pathMarker = (storePath: string): string =>
    `${pathsDir(own)}/${storePath.slice(storePath.lastIndexOf("/") + 1)}`;
  // The markers go first, so that a removal cut short leaves no marker.
  const remove = async (version: string): Promise<void> => {
    for (const path of [markerPath(version), pendingPath(version), pathsDir(version), dirOf(version)])
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
    setWritable: () => {},
    // Every file of the data was fsync()ed before this is written.
    mark: (marker) => writeWhole(fs, root, pendingPath(own), markerPath(own), marker),
    async pathInstalled(storePath) {
      try {
        return pathMarkerOf(JSON.parse(await fs.readFile(`${pathMarker(storePath)}${MARKER}`, "utf8")));
      } catch {
        return null;
      }
    },
    async markPath(storePath, marker) {
      await fs.mkdir(pathsDir(own), { recursive: true });
      const path = pathMarker(storePath);
      await writeWhole(fs, pathsDir(own), `${path}${PENDING}`, `${path}${MARKER}`, marker);
    },
    // A version's directory, its markers, its marker being written, or any
    // of them together.
    others: async () => [
      ...new Set(
        (await fs.readdir(root).catch(() => [] as string[]))
          .map((name) => name.replace(/\.(installed|marking|paths)$/, ""))
          .filter((version) => version !== own),
      ),
    ],
    remove,
    closed: () => false,
    quotaFailures: () => 0,
    quiet: () => undefined,
  };
};
