// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The storage scenarios: what the host mounts at the engine's directory,
// what it reports of it, and the locks it holds and lets go of. Each
// scenario's engine has storage of its own, named after it, so that no
// scenario's databases, directories or locks run into another's.

import { expect } from "vitest";
import type { Reply } from "./client.ts";
import type { ModuleManifest } from "@ibus-web/protocol";
import { memoryWithData, type StorageState } from "../../src/shared/messages.ts";
import { encodeComponent, engineDataLock, engineDir, engineWriterLock } from "../../src/shared/naming.ts";
import type { Client } from "./client.ts";
import {
  CRASH_REPORT_LIMIT_MS,
  type Harness,
  type HostOptions,
  type RunningHost,
  type RuntimeBuild,
  type TestArchive,
} from "./harness.ts";
import type { Message } from "./testing.ts";
import { LOCK_RELEASE_LIMIT_MS } from "./locks.ts";
import {
  call32,
  crashPrinted,
  errno,
  int32s,
  opsOf,
  poll,
  replyInt32s,
  round,
  stats,
  threadCrash,
} from "./scenarios.ts";

const KiB = 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const utf8 = (text: string): Uint8Array => encoder.encode(text);

// Where the test engines expect their data.
export const DATA_PATH = "/nix/store/00000000000000000000000000000000-test-data";

// The engine with the archive as its data, and the archive's version as its
// own.
export const withData = (engine: ModuleManifest, { version, url, size }: TestArchive): ModuleManifest => ({
  ...engine,
  version,
  data: [
    { url, storePath: DATA_PATH, size, encoding: "identity" },
    ...engine.data.filter((entry) => entry.storePath !== DATA_PATH),
  ],
});

// An engine of its own for a scenario on a runtime, named apart from those
// of any earlier run in the same browser, with the test archive as its data.
export const engineFor = (h: Harness, scenario: string, runtime: RuntimeBuild): ModuleManifest =>
  withData(
    {
      ...h.data.engines.empty,
      memory: h.data.constants.memory.minimum,
      name: `${scenario}-${runtime.name}-${Math.random().toString(36).slice(2, 8)}`,
    },
    h.data.archives.tree,
  );

// A host for the engine on the storage that outlives it.
export const storedHost = (
  h: Harness,
  runtime: RuntimeBuild,
  engine: ModuleManifest,
  more: Partial<HostOptions> = {},
) => h.start({ runtime, engine, storage: h.storage(engine), ...more });

const storageEvents = (messages: readonly Message[]): { state: StorageState; message: string }[] =>
  messages.flatMap((message) =>
    message.type === "storage" ? [{ state: message.state, message: message.message }] : [],
  );

// A read-file reply: the file's size, then its contents.
export const replyFile = ({ ret, bytes }: Reply): { status: number; text?: string } => {
  if (ret < 0) return { status: ret };
  const status = new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true);
  return status < 0 ? { status } : { status, text: decoder.decode(bytes.subarray(4)) };
};

const readFile = async (h: Harness, client: Client, path: string, readWrite = false) =>
  replyFile(await client.call(readWrite ? opsOf(h).readFileRdwr : opsOf(h).readFile, utf8(path)));

// write-file creates the file, writes the text into it, fsync()s and closes
// it; it replies with the bytes written.
const writeFile = (h: Harness, client: Client, path: string, text: string): Promise<number> =>
  call32(client, opsOf(h).writeFile, utf8(`${path}\0${text}`));

// fsync(path) from a thread while the host sleeps: the thread creates the
// file, writes its own path into it, fsync()s and closes it, and its result
// is the bytes it wrote, on every backend.
export const promiseProxiedFsync = async (h: Harness, { client }: RunningHost, paths: string[]): Promise<void> => {
  const ops = opsOf(h);
  const results: Record<string, string | number> = {};
  for (const path of paths) {
    expect(await call32(client, ops.fsync, utf8(path)), `fsync(${path}) started`).toBe(0);
    const result = await poll(h, client, ops.fsyncResult);
    results[path] = result.value === utf8(path).length ? `ok in ${round(result.ms, 1)} ms` : result.value;
    expect(result.value, `fsync(${path})`).toBe(utf8(path).length);
  }
  h.record("promise-proxied-fsync", results);
};

// A file new to the engine's directory, absent at first, written and
// fsync()ed on the host's thread, reads back the same through a side
// module, opened read-only and for reading and writing.
const roundTrip = async (h: Harness, client: Client, dir: string): Promise<void> => {
  const path = `${dir}/roundtrip-${Math.random().toString(36).slice(2)}.txt`;
  const contents = `written to ${path} by the runtime`;
  expect((await readFile(h, client, path)).status, "before it is written").toBe(-errno(h, "ENOENT"));
  expect(await writeFile(h, client, path, contents), "written").toBe(utf8(contents).length);
  expect(await readFile(h, client, path), "read").toEqual({ status: utf8(contents).length, text: contents });
  expect(await readFile(h, client, path, true), "read, opened for writing too").toEqual({
    status: utf8(contents).length,
    text: contents,
  });
};

// The engine's directory is mounted on the backend the environment's
// storage is, which hasn't closed, and a file round-trips through it.
export const storageRoundtrip = async (h: Harness, { client }: RunningHost, engine: ModuleManifest): Promise<void> => {
  const at = await stats(client);
  expect(at.mount, "mount").toBe(h.storageMount);
  expect(at.storageClosed, "closed").toBe(false);
  await roundTrip(h, client, engineDir(engine));
};

// A host that can't open IndexedDB mounts WasmFS's memory backend at the
// engine's directory, which starts no thread, makes the runtime's memory
// larger by the engine data's size in whole pages, and reports storage:
// ephemeral, alone; a file written there reads back. Runs first on a host
// of its own, so that no thread is alive yet.
export const storageFallback = async (
  h: Harness,
  { client, messages }: RunningHost,
  engine: ModuleManifest,
  memoryBytes: number,
): Promise<void> => {
  const at = await stats(client);
  const events = storageEvents(messages);
  h.record("storage-fallback", { mount: at.mount, memoryBytes: at.memoryBytes, events });
  expect(at.mount, "mount").toBe("memory");
  expect(at.memoryBytes, "the runtime's memory").toBe(
    memoryWithData({ initial: memoryBytes, maximum: memoryBytes }, engine).initial,
  );
  expect(at.idleWorkers, "idle Workers").toBe(h.data.pool.size);
  expect(events, "storage events").toEqual([{ state: "ephemeral", message: expect.any(String) }]);
  await roundTrip(h, client, engineDir(engine));
};

// When another connection opens the engine's database at a newer version,
// the IndexedDB backend's connection closes for it, saying why: a file
// created in the engine's directory then fails with EIO, and the host
// reports storage: closed, once. Leaves the engine's storage failing, so it
// runs on a host of its own.
export const storageClosed = async (h: Harness, { client, messages }: RunningHost, engine: ModuleManifest) => {
  if (h.upgradeDatabase === undefined) throw new Error("this environment can't upgrade a database");
  const before = await stats(client);
  expect(before.mount, "mount").toBe("indexeddb");
  expect(before.storageClosed, "closed before").toBe(false);
  const upgradeMs = await h.upgradeDatabase(engine);
  const written = await writeFile(h, client, `${engineDir(engine)}/after-close.txt`, "closed");
  const after = await stats(client);
  // The host posts its report when it wakes for a request; this thread
  // receives it once its event loop runs.
  const deadline = h.now() + h.pendingLimitMs;
  while (storageEvents(messages).length === 0 && h.now() < deadline) await h.sleep(10);
  await stats(client);
  const events = storageEvents(messages);
  h.record("storage-closed", { upgradeMs: round(upgradeMs, 2), written, events });
  expect(written, "write after the close").toBe(-errno(h, "EIO"));
  expect(after.storageClosed, "closed after").toBe(true);
  expect(events, "storage events").toEqual([
    { state: "closed", message: "the IndexedDB connection closed; the engine's storage fails with EIO" },
  ]);
  await h.printed.take(/^wasmfs-idb: ibus-web\/\S+ closed for a version change$/, { count: 1 });
};

// A version change while the host sleeps, with nothing due, wakes nothing;
// the page, which hears the change too, tells the host to check its
// storage, and the host reports the close without a request.
export const storageClosedIdle = async (h: Harness, host: RunningHost, engine: ModuleManifest) => {
  if (h.upgradeDatabase === undefined) throw new Error("this environment can't upgrade a database");
  const { client, messages } = host;
  expect((await stats(client)).storageClosed, "closed before").toBe(false);
  const upgrading = h.upgradeDatabase(engine);
  host.checkStorage();
  const upgradeMs = await upgrading;
  const deadline = h.now() + h.pendingLimitMs;
  while (storageEvents(messages).length === 0 && h.now() < deadline) await h.sleep(10);
  const events = storageEvents(messages);
  h.record("storage-closed-idle", { upgradeMs: round(upgradeMs, 2), events });
  expect(events, "storage events, with no request made").toEqual([
    { state: "closed", message: "the IndexedDB connection closed; the engine's storage fails with EIO" },
  ]);
  await h.printed.take(/^wasmfs-idb: ibus-web\/\S+ closed for a version change$/, { count: 1 });
};

const readOnlyOf = (host: RunningHost): boolean =>
  storageEvents(host.messages).some(({ state }) => state === "read-only");

// Of two hosts started on one engine, at once unless together is false,
// exactly one takes the engine's writer lock and mounts its user data read-write; the other
// reports storage: read-only, and with IndexedDB its writes fail with
// EROFS, while it reads what the writer wrote. Once the writer's Worker is
// terminated, a host started next, as a page starts it, takes the lock and
// writes. The Node backend has no read-only mode, so under Node only the
// lock and the report tell the hosts apart.
export const writerLock = async (
  h: Harness,
  runtime: RuntimeBuild,
  engine: ModuleManifest,
  together = true,
): Promise<void> => {
  const dir = engineDir(engine);
  const enforced = h.storageMount === "indexeddb";
  const refused = -errno(h, "EROFS");
  const hosts = together
    ? await Promise.all([storedHost(h, runtime, engine), storedHost(h, runtime, engine)])
    : [await storedHost(h, runtime, engine), await storedHost(h, runtime, engine)];
  let next: RunningHost | undefined;
  try {
    const readOnly = hosts.map(readOnlyOf);
    expect(
      readOnly.filter((ro) => !ro),
      "hosts that took the writer lock",
    ).toHaveLength(1);
    const writer = readOnly.indexOf(false);
    const reader = 1 - writer;
    const wrote = await Promise.all(
      hosts.map(({ client }, i) => writeFile(h, client, `${dir}/by-${i}.txt`, `by-${i}`)),
    );
    expect(wrote[writer], "the writer's write").toBe(utf8(`by-${writer}`).length);
    if (enforced) expect(wrote[reader], "the reader's write").toBe(refused);
    expect(
      await readFile(h, hosts[reader]!.client, `${dir}/by-${writer}.txt`),
      "the reader reads the writer's",
    ).toEqual({
      status: utf8(`by-${writer}`).length,
      text: `by-${writer}`,
    });

    const terminatedAt = h.now();
    await hosts[writer]!.terminate();
    next = await storedHost(h, runtime, engine);
    const nextReadyMs = h.now() - terminatedAt;
    const nextWrote = await writeFile(h, next.client, `${dir}/by-next.txt`, "by-next");
    const readerWroteAfter = await writeFile(h, hosts[reader]!.client, `${dir}/by-reader.txt`, "by-reader");
    h.record("writer-lock", {
      wrote,
      nextReadyAfterTerminateMs: round(nextReadyMs, 1),
      nextWrote,
      readerWroteAfter,
    });
    expect(readOnlyOf(next), "the next host read-only").toBe(false);
    expect(nextWrote, "the next host's write").toBe(utf8("by-next").length);
    expect(readOnlyOf(hosts[reader]!), "the reader read-only").toBe(true);
    if (enforced) expect(readerWroteAfter, "the reader's write after").toBe(refused);
  } finally {
    await Promise.all([...hosts, ...(next === undefined ? [] : [next])].map((host) => host.terminate()));
  }
};

// A bench operation's payload: its int32 arguments, then the path.
const benchPayload = (path: string, ...args: number[]): Uint8Array => {
  const head = int32s(...args);
  const tail = utf8(path);
  const payload = new Uint8Array(head.length + tail.length);
  payload.set(head);
  payload.set(tail, head.length);
  return payload;
};

// A few MiB that end partway into a chunk, as a file's end usually does.
const DICTIONARY_BYTES = 4096 * KiB + 104 * KiB;

// How long one bench request may hold the page: its time depends on the
// disk, and a host that never replies still fails.
const BENCH_BUDGET_MS = 60_000;

// An engine-like dictionary file in the engine's directory, written in
// 64 KiB writes and fsync()ed, read at random in 4 KiB and 64 KiB reads, one
// batch and then one read a request, and appended to in 64-byte records
// each fsync()ed, which read back too: every write and fsync() succeeds and
// every read returns the file's bytes. A bench reply starts with its status
// and, for reads, the count of reads that returned the file's bytes.
// Correctness only: a batch is many keystrokes' worth of I/O in one request,
// with real fsync()s under Node and strict commits in a browser, so each
// request holds the page for as long as it takes, up to BENCH_BUDGET_MS, and
// nothing here is timed.
export const storageCosts = async (h: Harness, { client }: RunningHost, engine: ModuleManifest): Promise<void> => {
  const ops = opsOf(h);
  const path = `${engineDir(engine)}/dictionary-${Math.random().toString(36).slice(2)}.bin`;
  const bench = async (opcode: number, ...args: number[]) =>
    replyInt32s(await client.call(opcode, benchPayload(path, ...args), { budgetMs: BENCH_BUDGET_MS }));
  expect((await bench(ops.benchWrite, DICTIONARY_BYTES, 64 * KiB))[0], "write").toBe(0);
  let seed = 1;
  for (const [size, batch, single] of [
    [4 * KiB, 256, 100],
    [64 * KiB, 64, 30],
  ] as const) {
    expect((await bench(ops.benchRead, size, batch, seed++, 0)).slice(0, 2), `${size}-byte reads`).toEqual([0, batch]);
    for (let i = 0; i < single; i++)
      expect((await bench(ops.benchRead, size, 1, seed++, 0)).slice(0, 2), `a ${size}-byte read`).toEqual([0, 1]);
  }
  expect((await bench(ops.benchAppend, 64, 100))[0], "appends").toBe(0);
  expect((await bench(ops.benchRead, 64, 100, seed++, DICTIONARY_BYTES)).slice(0, 2), "appended reads").toEqual([
    0, 100,
  ]);
};

// The lock a host holds beside the writer lock for as long as it runs.
const dataLock = (engine: ModuleManifest): string => engineDataLock(engine, encodeComponent(engine.version));

// Polls until the lock is free, for at most the page's bound on a lock's
// release: a lock a host lets go of reaches the lock manager a moment later.
const freeSoon = async (h: Harness, name: string): Promise<boolean> => {
  const deadline = h.now() + LOCK_RELEASE_LIMIT_MS;
  for (;;) {
    if (await h.locks.free(name)) return true;
    if (h.now() >= deadline) return false;
    await h.sleep(10);
  }
};

// The locks as a host that stopped left them: every other lock free, and the
// writer lock free or kept, as expected. A host that lets go of the writer
// lock does so before the data lock, which it took later, so once the data
// lock is free a writer lock still held is kept, and needs no longer wait. A
// page's own wait for the writer lock, once it has seen a host fail, may
// hold it a moment.
const locksAfter = async (h: Harness, engine: ModuleManifest, writerFree: boolean): Promise<void> => {
  expect(await freeSoon(h, dataLock(engine)), "the data lock let go of").toBe(true);
  const writer = engineWriterLock(engine);
  if (writerFree) expect(await freeSoon(h, writer), "the writer lock let go of").toBe(true);
  else expect(await h.locks.free(writer), "the writer lock kept").toBe(false);
};

const crashedLogs = (host: RunningHost): string[] =>
  host.client.page.records().flatMap(({ record }) => (record._tag === "Log" ? [record.message] : []));

// A host whose relay fails crashes with its runtime intact: it seals its
// user data, then lets go of every lock, the writer lock included.
export const crashReleasesLocks = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const engine = engineFor(h, "crash-releases-locks", runtime);
  const host = await storedHost(h, runtime, engine, { relayFailsAfter: 3 });
  try {
    expect(await h.locks.free(dataLock(engine)), "the data lock while the host runs").toBe(false);
    expect(await h.locks.free(engineWriterLock(engine)), "the writer lock while the host runs").toBe(false);
    await crashByRelay(h, host);
    await locksAfter(h, engine, true);
    expect(crashedLogs(host), "logs").toEqual([]);
  } finally {
    await host.terminate();
  }
};

const crashByRelay = async (h: Harness, { client }: RunningHost): Promise<void> => {
  for (let i = 0; i < 10; i++)
    try {
      await call32(client, opsOf(h).add, int32s(i, 1));
    } catch {
      break;
    }
  expect(await client.crashReport(CRASH_REPORT_LIMIT_MS), "the crash report").toMatch(/^relay: /);
};

// Terminates the host, whose Worker ends with it, and with the Worker any
// writer lock it kept: the page's bounded wait for the lock then gets it.
const writerFreedByTerminate = async (h: Harness, host: RunningHost, engine: ModuleManifest): Promise<void> => {
  const terminatedAt = h.now();
  await host.terminate();
  const freed = await h.locks.released(engineWriterLock(engine));
  h.record("writer lock let go after terminate()", { ms: round(h.now() - terminatedAt, 1) });
  expect(freed, `the writer lock free within ${LOCK_RELEASE_LIMIT_MS} ms of terminate()`).toBe(true);
};

// A seal that throws on the crash path leaves the user data writable, so
// the host keeps the writer lock until its Worker ends, and says so; it lets
// go of every other lock. Only an IndexedDB backend is sealed.
export const sealThrows = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const engine = engineFor(h, "seal-throws", runtime);
  const host = await storedHost(h, runtime, engine, {
    relayFailsAfter: 3,
    test: { sealThrows: true },
  });
  try {
    await crashByRelay(h, host);
    await locksAfter(h, engine, false);
    expect(crashedLogs(host), "logs").toEqual([
      expect.stringMatching(
        new RegExp(
          `^sealing the engine's user data failed, so this host keeps ${engineWriterLock(engine)} until its Worker ends: Error: the seal fails on purpose`,
        ),
      ),
    ]);
  } finally {
    await writerFreedByTerminate(h, host, engine);
  }
};

// A thread that traps leaves a runtime that can't be called to seal the
// user data: the host keeps the writer lock until its Worker ends, and lets
// go of every other lock. A Node backend, which has no seal, keeps nothing.
export const trapKeepsWriter = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const engine = engineFor(h, "trap-keeps-writer", runtime);
  const host = await storedHost(h, runtime, engine);
  try {
    await threadCrash(h, host);
    await crashPrinted(h, runtime);
    await locksAfter(h, engine, h.storageMount === "node");
  } finally {
    await writerFreedByTerminate(h, host, engine);
  }
};

// A start that fails once storage is mounted, here at a side module that
// registers an opcode another holds, seals the user data and lets go of
// every lock, the writer lock included.
export const failedStartReleasesLocks = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const engine = engineFor(h, "failed-start-releases-locks", runtime);
  const trivial = h.sides.find(({ name }) => name === "trivial");
  if (trivial === undefined) throw new Error("no trivial side module");
  await expect(
    storedHost(h, runtime, engine, {
      moreSides: [{ name: "trivial-again", bytes: trivial.bytes }],
    }),
  ).rejects.toThrow(`host: Error: load trivial-again: -${errno(h, "EEXIST")}`);
  await locksAfter(h, engine, true);
  await h.printed.take(/ibus-web-WARNING.*Module \/sides\/trivial-again\.wasm can't register add as opcode/, {
    count: 1,
  });
};
