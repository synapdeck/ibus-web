// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The storage experiments' side of the experiment Worker. Each read is
// awaited before the next starts, as a backend serving lazy reads would.

import { chunkUrl, type StorageCommand, type Timing, type UpgradeOutcome } from "../shared/storage.ts";

const now = (): number => performance.timeOrigin + performance.now();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// getRandomValues() fills at most 64 KiB a call. Random bytes keep IndexedDB
// implementations that compress values from flattering the timings.
const randomBytes = (size: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(size);
  for (let at = 0; at < size; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(at + 65536, size)));
  return bytes;
};

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const committed = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () =>
      reject(transaction.error ?? new DOMException("aborted", "AbortError"));
  });

const kept = new Map<string, { db: IDBDatabase; events: string[] }>();

const connect = async (name: string, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> => {
  const open = indexedDB.open(name, 1);
  if (upgrade !== undefined) open.onupgradeneeded = () => upgrade(open.result);
  return request(open);
};

const fileHandle = async (name: string, create = false): Promise<FileSystemFileHandle> =>
  (await navigator.storage.getDirectory()).getFileHandle(name, { create });

let held: FileSystemSyncAccessHandle | null = null;

export const runStorage = async (command: StorageCommand): Promise<unknown> => {
  const received = now();
  const marks: [string, number][] = [];
  const mark = (step: string, at = now()): void => {
    marks.push([step, at - ("epoch" in command ? command.epoch : 0)]);
  };
  switch (command.op) {
    case "idb-fill": {
      const db = await connect(command.db, (db) => {
        for (const { name } of command.stores) db.createObjectStore(name);
      });
      for (const { name, chunks, size, blob } of command.stores) {
        const transaction = db.transaction(name, "readwrite");
        const store = transaction.objectStore(name);
        for (let key = 0; key < chunks; key++) {
          const bytes = randomBytes(size);
          store.put(blob ? new Blob([bytes]) : bytes.buffer, key);
        }
        await committed(transaction);
      }
      db.close();
      return null;
    }
    case "cache-fill": {
      const cache = await caches.open(command.cache);
      for (let i = 0; i < command.chunks; i++)
        await cache.put(
          new URL(chunkUrl(command.cache, i), self.location.href),
          new Response(randomBytes(command.size)),
        );
      return null;
    }
    case "opfs-fill": {
      const handle = await (await fileHandle(command.file, true)).createSyncAccessHandle();
      handle.truncate(0);
      handle.write(randomBytes(command.size), { at: 0 });
      handle.flush();
      handle.close();
      return null;
    }
    case "idb-open": {
      const db = await connect(command.db);
      const events: string[] = [];
      db.onversionchange = () => events.push("versionchange");
      kept.set(command.db, { db, events });
      return null;
    }
    case "idb-close": {
      const { db, events } = kept.get(command.db)!;
      db.close();
      kept.delete(command.db);
      return events;
    }
    case "idb-upgrade": {
      const started = now();
      const open = indexedDB.open(command.db, command.version);
      let blocked = false;
      open.onblocked = () => {
        blocked = true;
      };
      const db = await Promise.race([request(open), sleep(command.waitMs).then(() => null)]);
      if (db === null) open.onsuccess = () => open.result.close();
      else db.close();
      return {
        blocked,
        opened: db !== null,
        ms: now() - started,
      } satisfies UpgradeOutcome;
    }
    case "opfs-hold":
      held = await (await fileHandle(command.file)).createSyncAccessHandle();
      return null;
    case "opfs-release":
      held?.close();
      held = null;
      return null;
    case "idb-read": {
      mark("message received", received);
      let db = kept.get(command.db)?.db;
      if (db === undefined) {
        db = await connect(command.db);
        mark("indexedDB.open()");
      }
      const transaction = db.transaction(command.store, "readonly");
      const done = committed(transaction);
      const store = transaction.objectStore(command.store);
      const values: unknown[] = [];
      for (let key = 0; key < command.chunks; key++) {
        values.push(await request(store.get(key)));
        if (key === 0) mark("first get()");
      }
      mark("every get()");
      await done;
      mark("transaction complete");
      let bytes = 0;
      for (const [i, value] of values.entries()) {
        if (value instanceof Blob) {
          bytes += (await value.arrayBuffer()).byteLength;
          if (i === 0) mark("first Blob arrayBuffer()");
          if (i === values.length - 1) mark("every Blob arrayBuffer()");
        } else bytes += (value as ArrayBuffer).byteLength;
      }
      if (!kept.has(command.db)) db.close();
      return { marks, bytes } satisfies Timing;
    }
    case "idb-write": {
      mark("message received", received);
      const { db } = kept.get(command.db)!;
      const transaction = db.transaction(command.store, "readwrite");
      const done = committed(transaction);
      const store = transaction.objectStore(command.store);
      for (let key = 0; key < command.chunks; key++) await request(store.put(randomBytes(command.size).buffer, key));
      mark("every put()");
      await done;
      mark("transaction complete");
      return { marks, bytes: command.chunks * command.size } satisfies Timing;
    }
    case "cache-read": {
      mark("message received", received);
      const cache = await caches.open(command.cache);
      mark("caches.open()");
      let bytes = 0;
      for (let i = 0; i < command.chunks; i++) {
        const response = await cache.match(new URL(chunkUrl(command.cache, i), self.location.href));
        if (i === 0) mark("first match()");
        bytes += (await response!.arrayBuffer()).byteLength;
        if (i === 0) mark("first Response arrayBuffer()");
      }
      mark("every chunk");
      return { marks, bytes } satisfies Timing;
    }
    case "opfs-blob-read": {
      mark("message received", received);
      const handle = await fileHandle(command.file);
      mark("getFileHandle()");
      const file = await handle.getFile();
      mark("getFile()");
      let bytes = 0;
      for (let i = 0; i < command.chunks; i++) {
        const at = i * command.size;
        bytes += (await file.slice(at, at + command.size).arrayBuffer()).byteLength;
        if (i === 0) mark("first slice arrayBuffer()");
      }
      mark("every slice arrayBuffer()");
      return { marks, bytes } satisfies Timing;
    }
    case "opfs-sync-read": {
      mark("message received", received);
      const handle = await (await fileHandle(command.file)).createSyncAccessHandle();
      mark("createSyncAccessHandle()");
      const buffer = new Uint8Array(command.size);
      let bytes = 0;
      for (let i = 0; i < command.chunks; i++) {
        bytes += handle.read(buffer, { at: i * command.size });
        if (i === 0) mark("first read()");
      }
      mark("every read()");
      handle.close();
      mark("close()");
      return { marks, bytes } satisfies Timing;
    }
    case "latency": {
      const times: number[] = [];
      const pick = (): number => Math.floor(Math.random() * command.count);
      switch (command.source) {
        case "idb-tx-per-read":
        case "idb-one-tx": {
          const db = await connect(command.db);
          const shared =
            command.source === "idb-one-tx"
              ? db.transaction(command.store, "readonly").objectStore(command.store)
              : null;
          for (let i = 0; i < command.reads; i++) {
            const start = now();
            const store = shared ?? db.transaction(command.store, "readonly").objectStore(command.store);
            await request(store.get(pick()));
            times.push(now() - start);
          }
          db.close();
          break;
        }
        case "opfs-sync": {
          const handle = await (await fileHandle(command.file)).createSyncAccessHandle();
          const buffer = new Uint8Array(command.size);
          for (let i = 0; i < command.reads; i++) {
            const start = now();
            handle.read(buffer, { at: pick() * command.size });
            times.push(now() - start);
          }
          handle.close();
          break;
        }
        case "opfs-blob": {
          const file = await (await fileHandle(command.file)).getFile();
          for (let i = 0; i < command.reads; i++) {
            const start = now();
            const at = pick() * command.size;
            await file.slice(at, at + command.size).arrayBuffer();
            times.push(now() - start);
          }
          break;
        }
      }
      return times;
    }
  }
};
