// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The storage Worker's script: it answers the page's one request about the
// modules' databases, then the page ends it. It reads in read-only
// transactions, each on a connection of its own that closes at a version
// change, and so holds up no host's writes past the transaction itself.

import { packTar, type TarEntry } from "modern-tar";
import { enginePathMarker } from "../shared/naming.ts";
import type { DatabaseUsage, ModuleDatabases, StorageReply, StorageRequest } from "../shared/storage.ts";
import { deleteDatabase, idbRequest, openExisting } from "./storage/idb.ts";

// What the backend stores for an inode: kind 1 a file, 2 a directory, 3 a
// symlink, times in milliseconds.
interface Inode {
  kind: number;
  mode: number;
  size: number;
  mtime: number;
  target?: string;
}

const FILE = 1;
const DIRECTORY = 2;

// Runs body in one read-only transaction over stores of the database, and
// resolves once it has completed; a database that doesn't exist gives none.
const reading = async <T>(
  database: string,
  stores: string[],
  none: T,
  body: (tx: IDBTransaction) => Promise<T>,
): Promise<T> => {
  const db = await openExisting(database);
  if (db === null) return none;
  try {
    const tx = db.transaction(stores, "readonly");
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error(`reading ${database} was aborted`));
    });
    const result = await body(tx);
    await done;
    return result;
  } finally {
    db.close();
  }
};

// The bytes of file data the user data holds.
const userBytes = (database: string): Promise<number> =>
  reading(database, ["inodes"], 0, async (tx) => {
    const inodes = (await idbRequest(tx.objectStore("inodes").getAll())) as Inode[];
    return inodes.reduce((sum, { kind, size }) => (kind === FILE ? sum + size : sum), 0);
  });

const markedBytes = (value: unknown, version?: string): number | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const marker = value as { version?: unknown; bytes?: unknown };
  if (version !== undefined && marker.version !== version) return undefined;
  return typeof marker.bytes === "number" ? marker.bytes : undefined;
};

const usageOf = async ({ user, data, version, paths }: ModuleDatabases): Promise<DatabaseUsage> => {
  const userData = await userBytes(user);
  const markers = await reading(data, ["meta"], undefined, async (tx) => {
    const meta = tx.objectStore("meta");
    const [base, ...each] = await Promise.all([
      idbRequest(meta.get("installed")),
      ...paths.map((path) => idbRequest(meta.get(enginePathMarker(path)))),
    ]);
    return { base, each };
  });
  if (markers === undefined) return { userData, base: 0, paths: {} };

  const installed: Record<string, number> = {};
  paths.forEach((path, i) => {
    const bytes = markedBytes(markers.each[i]);
    if (bytes !== undefined) installed[path] = bytes;
  });
  return { userData, base: markedBytes(markers.base, version) ?? 0, paths: installed };
};

// Every file, directory and link of the user data, as the transaction sees
// them, named from its root.
const exportOf = (database: string): Promise<Uint8Array<ArrayBuffer>> =>
  reading(database, ["meta", "inodes", "entries", "chunks"], new Uint8Array(1024), async (tx) => {
    const meta = tx.objectStore("meta");
    const [root, chunkSize, keys, children, inos, inodes] = await Promise.all([
      idbRequest(meta.get("root")),
      idbRequest(meta.get("chunkSize")),
      idbRequest(tx.objectStore("entries").getAllKeys()),
      idbRequest(tx.objectStore("entries").getAll()),
      idbRequest(tx.objectStore("inodes").getAllKeys()),
      idbRequest(tx.objectStore("inodes").getAll()),
    ]);
    const inode = new Map((inos as number[]).map((ino, i) => [ino, (inodes as Inode[])[i]!]));
    const listing = new Map<number, [string, number][]>();
    (keys as [number, string][]).forEach(([parent, name], i) => {
      const list = listing.get(parent) ?? [];
      list.push([name, (children as number[])[i]!]);
      listing.set(parent, list);
    });

    const files: { path: string; ino: number; inode: Inode }[] = [];
    const walk = (dir: number, prefix: string): void => {
      for (const [name, ino] of (listing.get(dir) ?? []).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const found = inode.get(ino);
        if (found === undefined) continue;
        files.push({ path: `${prefix}${name}`, ino, inode: found });
        if (found.kind === DIRECTORY) walk(ino, `${prefix}${name}/`);
      }
    };
    walk(typeof root === "number" ? root : 1, "");

    const chunks = tx.objectStore("chunks");
    const entries = await Promise.all(
      files.map(async ({ path, ino, inode: { kind, mode, size, mtime, target } }): Promise<TarEntry> => {
        const header = { name: path, mode: mode & 0o7777, mtime: new Date(mtime) };
        if (kind === DIRECTORY) return { header: { ...header, name: `${path}/`, size: 0, type: "directory" } };
        if (kind !== FILE) return { header: { ...header, size: 0, type: "symlink", linkname: target ?? "" } };

        const body = new Uint8Array(size);
        const range = IDBKeyRange.bound([ino, 0], [ino, Infinity]);
        const [pieces, indices] = (await Promise.all([
          idbRequest(chunks.getAll(range)),
          idbRequest(chunks.getAllKeys(range)),
        ])) as [ArrayBuffer[], [number, number][]];
        indices.forEach(([, index], i) => {
          const offset = index * (chunkSize as number);
          if (offset < size) body.set(new Uint8Array(pieces[i]!).subarray(0, size - offset), offset);
        });
        return { header: { ...header, size, type: "file" }, body };
      }),
    );
    return packTar(entries);
  });

const answer = async (request: StorageRequest): Promise<StorageReply> => {
  switch (request.type) {
    case "usage":
      return { type: "usage", modules: await Promise.all(request.modules.map(usageOf)) };
    case "export":
      return { type: "export", archive: await exportOf(request.database) };
    case "reset":
      await deleteDatabase(request.database, request.limitMs);
      return { type: "reset" };
  }
};

self.addEventListener(
  "message",
  ({ data }: MessageEvent<StorageRequest>) => {
    answer(data).then(
      (reply) => self.postMessage(reply, reply.type === "export" ? [reply.archive.buffer] : []),
      (error: unknown) =>
        self.postMessage({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        } satisfies StorageReply),
    );
  },
  { once: true },
);
