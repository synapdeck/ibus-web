// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, expect, test, vi } from "vitest";
import { Stream } from "effect";
import { Connection, type SettingsSourceService } from "@ibus-web/core";
import { engineDataDatabase, engineWriterLock } from "@ibus-web/worker-host";
import { createIbusWeb, StorageUnavailable, type IbusWeb } from "../../src/index.ts";
import { DomConnection } from "../../../core/test/browser/support/dom.ts";

const lazy = `/nix/store/${"b".repeat(32)}-lazy`;
const manifest = {
  name: "test",
  version: "1",
  license: "MIT",
  runtimeAbi: 1,
  runtimeIdentity: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  protocol: 1,
  module: { url: "engine.so", size: 1 },
  memory: 65536,
  threads: 0,
  data: [
    { storePath: `/nix/store/${"a".repeat(32)}-test`, url: "data.tar", size: 0, files: 1, encoding: "identity" },
    { storePath: lazy, url: "lazy.tar", size: 0, files: 1, encoding: "identity" },
  ],
  settingsSchemaDir: `/nix/store/${"a".repeat(32)}-test/schemas`,
  engines: [
    { name: "test", displayName: "test", languages: [], keyboard: { layout: "us", passThrough: [] } },
    { name: "lazy", displayName: "lazy", languages: [], keyboard: { layout: "us", passThrough: [] }, data: [lazy] },
  ],
  settingsSchemas: [],
};
const user = "ibus-web/test";
const data = "ibus-web/test/data/1";
const older = engineDataDatabase({ name: "test", version: "0.9 beta" });
const chunkSize = 16384;
const deep = Uint8Array.from({ length: 20000 }, (_, i) => (i % 251) + 1);
const settings: SettingsSourceService = { snapshot: async () => ({}), written: () => {}, changes: Stream.empty };
const apps: IbusWeb[] = [];

const settled = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

// Writes a database's stores as a module's would hold them, then closes it.
const make = async (name: string, stores: string[], fill: (tx: IDBTransaction) => void): Promise<void> => {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => {
    for (const store of stores) request.result.createObjectStore(store);
  };
  const db = await settled(request);
  const tx = db.transaction(stores, "readwrite");
  fill(tx);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  db.close();
};

// The user data as the IndexedDB backend stores it: a file, a directory
// holding a file of two chunks, and a link; and the version's data with its
// marker and one engine's own path's.
const stored = async (): Promise<void> => {
  const encoder = new TextEncoder();
  const node = (kind: number, mode: number, size = 0, target?: string) => ({
    kind,
    mode,
    size,
    atime: 0,
    mtime: Date.UTC(2026, 9, 12),
    ctime: 0,
    ...(target === undefined ? {} : { target }),
  });
  await make(user, ["meta", "inodes", "entries", "chunks"], (tx) => {
    const meta = tx.objectStore("meta");
    meta.put(1, "format");
    meta.put(chunkSize, "chunkSize");
    meta.put(6, "nextIno");
    meta.put(1, "root");
    const inodes = tx.objectStore("inodes");
    inodes.put(node(2, 0o777), 1);
    inodes.put(node(1, 0o644, 5), 2);
    inodes.put(node(2, 0o755), 3);
    inodes.put(node(1, 0o600, deep.length), 4);
    inodes.put(node(3, 0o777, 0, "notes.txt"), 5);
    const entries = tx.objectStore("entries");
    entries.put(2, [1, "notes.txt"]);
    entries.put(3, [1, "sub"]);
    entries.put(4, [3, "deep.bin"]);
    entries.put(5, [1, "link"]);
    const chunks = tx.objectStore("chunks");
    chunks.put(encoder.encode("hello").buffer, [2, 0]);
    chunks.put(deep.slice(0, chunkSize).buffer, [4, 0]);
    chunks.put(deep.slice(chunkSize).buffer, [4, 1]);
  });
  await make(data, ["meta"], (tx) => {
    const meta = tx.objectStore("meta");
    meta.put({ version: "1", files: 3, bytes: 1000 }, "installed");
    meta.put({ files: 2, bytes: 10 }, `paths/${lazy}`);
  });
};

// A tar's members: name, type flag, link target and data.
const members = (archive: Uint8Array): { name: string; type: string; linkname: string; data: Uint8Array }[] => {
  const decoder = new TextDecoder();
  const field = (block: Uint8Array, at: number, length: number) =>
    decoder.decode(block.subarray(at, at + length)).replace(/\0.*$/s, "");
  const list = [];
  for (let at = 0; at + 512 <= archive.length;) {
    const block = archive.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(block, 124, 12).trim() || "0", 8);
    const prefix = field(block, 345, 155);
    const name = field(block, 0, 100);
    list.push({
      name: prefix === "" ? name : `${prefix}/${name}`,
      type: field(block, 156, 1),
      linkname: field(block, 157, 100),
      data: archive.slice(at + 512, at + 512 + size),
    });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return list;
};

const facade = () => {
  const connections: DomConnection[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(manifest));
  vi.spyOn(Connection, "start").mockImplementation(async () => {
    const connection = new DomConnection();
    connections.push(connection);
    return connection as unknown as Connection;
  });
  const app = createIbusWeb({
    runtimeUrl: new URL("https://example.test/runtime/ibus-runtime.js"),
    hostUrl: new URL("/@ibus-web-facade/host/index.js", location.href),
    modules: { test: new URL("https://example.test/manifest.json") },
    settings,
  });
  apps.push(app);
  return { app, connections };
};

afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  vi.restoreAllMocks();
  for (const name of [user, data, older]) await settled(indexedDB.deleteDatabase(name));
});

test("usage gives each module's installed data, user data and engines' own data, starting no module's Worker", async () => {
  await stored();
  const { app, connections } = facade();
  expect(await app.storage.usage()).toEqual({
    modules: {
      test: {
        data: 1010,
        userData: 5 + deep.length,
        engines: { test: { data: 0 }, lazy: { data: 10 } },
        version: "1",
        versions: { "1": { data: 1010 } },
        total: 1010 + 5 + deep.length,
      },
    },
  });
  expect(connections).toEqual([]);
});

test("usage counts a module with no databases as none", async () => {
  const { app } = facade();
  expect(await app.storage.usage()).toEqual({
    modules: {
      test: {
        data: 0,
        userData: 0,
        engines: { test: { data: 0 }, lazy: { data: 0 } },
        version: "1",
        versions: {},
        total: 0,
      },
    },
  });
});

test("usage gives every version's data still stored, an older one's beside the current one's", async () => {
  await stored();
  await make(older, ["meta"], (tx) => {
    const meta = tx.objectStore("meta");
    meta.put({ version: "0.9 beta", files: 2, bytes: 700 }, "installed");
    meta.put({ files: 1, bytes: 30 }, `paths/${lazy}`);
    meta.put({ files: 1, bytes: 4 }, `paths//nix/store/${"c".repeat(32)}-gone`);
  });
  const { app } = facade();
  const { test: usage } = (await app.storage.usage()).modules;
  expect(usage).toEqual({
    data: 1010,
    userData: 5 + deep.length,
    engines: { test: { data: 0 }, lazy: { data: 10 } },
    version: "1",
    versions: { "1": { data: 1010 }, "0.9 beta": { data: 734 } },
    total: 1010 + 734 + 5 + deep.length,
  });
});

test("export gives the user data as a tar, once a running module has persisted", async () => {
  await stored();
  const { app, connections } = facade();
  await app.select("test");
  const archive = await app.storage.export("test");
  expect(archive.type).toBe("application/x-tar");
  expect(connections[0]!.sent.map(({ request }) => request._tag)).toContain("Persist");

  const decoder = new TextDecoder();
  expect(
    members(new Uint8Array(await archive.arrayBuffer())).map(({ name, type, linkname, data }) => ({
      name,
      type,
      linkname,
      text: type === "0" && name === "notes.txt" ? decoder.decode(data) : data.length,
    })),
  ).toEqual([
    { name: "link", type: "2", linkname: "notes.txt", text: 0 },
    { name: "notes.txt", type: "0", linkname: "", text: "hello" },
    { name: "sub/", type: "5", linkname: "", text: 0 },
    { name: "sub/deep.bin", type: "0", linkname: "", text: deep.length },
  ]);
  const deepBin = members(new Uint8Array(await archive.arrayBuffer())).find(({ name }) => name === "sub/deep.bin")!;
  expect(deepBin.data).toEqual(deep);
});

test("export in a tab not running the module has the tab holding its writer lock persist first", async () => {
  await stored();
  const writer = facade();
  await writer.app.select("test");
  const reader = facade();
  const persists = () => writer.connections[0]!.sent.filter(({ request }) => request._tag === "Persist").length;
  const before = persists();

  // The writer's host is a stand-in that takes no lock, so the test holds it in the host's place.
  let release!: () => void;
  const holding = new Promise<void>((resolve) => (release = resolve));
  await new Promise<void>((acquired) => {
    void navigator.locks.request(engineWriterLock({ name: "test" }), () => {
      acquired();
      return holding;
    });
  });
  try {
    const started = performance.now();
    const archive = await reader.app.storage.export("test");
    expect(persists()).toBe(before + 1);
    expect(performance.now() - started, "answered, not waited out").toBeLessThan(5000);
    expect(reader.connections).toEqual([]);
    expect(archive.size).toBeGreaterThan(0);
  } finally {
    release();
  }
});

test("reset deletes the user data and starts the selected module again, with its selection", async () => {
  await stored();
  const { app, connections } = facade();
  await app.select("test", "test");
  await app.storage.reset("test");
  expect((await indexedDB.databases()).map(({ name }) => name)).not.toContain(user);
  expect((await indexedDB.databases()).map(({ name }) => name)).toContain(data);
  expect(connections).toHaveLength(2);
  expect(app.selection).toEqual({ module: "test", engine: "test" });
});

test("a reset another tab's connection holds up past its limit rejects with StorageUnavailable", async () => {
  await stored();
  const { app } = facade();
  const held = await settled(indexedDB.open(user));
  try {
    const failed = await app.storage.reset("test").catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(StorageUnavailable);
    expect(failed).toMatchObject({ module: "test", diagnostic: expect.stringContaining("stayed open") });
  } finally {
    held.close();
  }
}, 20_000);

test("an unknown module is the caller's mistake, a plain Error", async () => {
  const { app } = facade();
  await expect(app.storage.export("missing")).rejects.toThrow("Unknown module: missing");
});
