// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The storage Worker against databases a running host made, which only a
// browser has.

import type { WasmModuleManifest } from "@ibus-web/protocol";
import { unpackTar } from "modern-tar";
import { expect } from "vitest";
import {
  engineDatabase,
  engineDataDatabase,
  engineDataDatabasePrefix,
  engineDir,
  enginePathMarker,
} from "../../src/shared/naming.ts";
import type { StorageReply, StorageRequest } from "../../src/shared/storage.ts";
import type { Harness, RunningHost } from "../shared/harness.ts";
import { installOf } from "../shared/install.ts";
import { storageEvents, writeFile } from "../shared/storage.ts";

// The storage Worker's answer to one request, as the page asks it.
const askStorage = (h: Harness, request: StorageRequest): Promise<StorageReply> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL("storage.js", new URL(h.data.hostUrl, location.href)), { type: "module" });
    worker.addEventListener("message", ({ data }: MessageEvent<StorageReply>) => {
      worker.terminate();
      resolve(data);
    });
    worker.addEventListener("error", (event) => {
      worker.terminate();
      reject(new Error(event.message));
    });
    worker.postMessage(request);
  });

const settled = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const deleteDatabase = (name: string): Promise<unknown> => settled(indexedDB.deleteDatabase(name));

// A version's data as a host leaves it installed, its markers alone: its
// base data's and one store path's of an engine's own.
const olderVersion = async (database: string, version: string): Promise<void> => {
  const request = indexedDB.open(database, 1);
  request.onupgradeneeded = () => request.result.createObjectStore("meta");
  const db = await settled(request);
  const tx = db.transaction(["meta"], "readwrite");
  tx.objectStore("meta").put({ version, files: 3, bytes: 1000 }, "installed");
  tx.objectStore("meta").put({ files: 2, bytes: 24 }, enginePathMarker(`/nix/store/${"c".repeat(32)}-older`));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  db.close();
};

// The storage Worker reads a module's databases as a running host made them:
// the user data's bytes, the version's as its marker records them and every
// version's stored, an older one's among them; the user data as a tar of its
// files, whole across chunks; and it deletes the user data, whose host
// closes its connection for it.
export const storageWorker = async (h: Harness, host: RunningHost, engine: WasmModuleManifest): Promise<void> => {
  const dir = engineDir(engine);
  const big = "0123456789".repeat(4000);
  expect(await writeFile(h, host.client, `${dir}/small.txt`, "small")).toBe(5);
  expect(await writeFile(h, host.client, `${dir}/big.txt`, big)).toBe(big.length);
  const user = engineDatabase(engine);

  // An older version's data, which no host has collected yet.
  const older = { name: engine.name, version: `${engine.version}-older` };
  await olderVersion(engineDataDatabase(older), older.version);
  try {
    const base = installOf(host.messages)!.bytes;
    expect(
      await askStorage(h, {
        type: "usage",
        modules: [
          {
            user,
            data: engineDataDatabase(engine),
            version: engine.version,
            paths: [],
            dataPrefix: engineDataDatabasePrefix(engine),
          },
        ],
      }),
    ).toEqual({
      type: "usage",
      modules: [
        {
          userData: 5 + big.length,
          base,
          paths: {},
          versions: { [engine.version]: base, [older.version]: 1000 + 24 },
        },
      ],
    });
  } finally {
    await deleteDatabase(engineDataDatabase(older));
  }

  const exported = await askStorage(h, { type: "export", database: user });
  if (exported.type !== "export") throw new Error(`export answered ${JSON.stringify(exported)}`);
  const decoder = new TextDecoder();
  expect(
    (await unpackTar(exported.archive)).map(({ header, data }) => ({
      name: header.name,
      type: header.type,
      text: decoder.decode(data),
    })),
  ).toEqual([
    { name: "big.txt", type: "file", text: big },
    { name: "small.txt", type: "file", text: "small" },
  ]);

  // The page hears the deletion's version change too, and has the host check.
  const resetting = askStorage(h, { type: "reset", database: user, limitMs: 10_000 });
  host.checkStorage();
  expect(await resetting).toEqual({ type: "reset" });
  expect((await indexedDB.databases()).map((info: { name?: string }) => info.name)).not.toContain(user);
  const deadline = h.now() + h.pendingLimitMs;
  while (storageEvents(host.messages).length === 0 && h.now() < deadline) await h.sleep(10);
  expect(storageEvents(host.messages).map(({ state }) => state)).toEqual(["closed"]);
  await h.printed.take(/^wasmfs-idb: ibus-web\/\S+ closed for a version change$/, { count: 1 });
};
