// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The spike's Worker host. Its one message is a HostInit: it decides what to
// mount at its engine's directory, read-write only if it holds the engine's
// writer lock, makes the runtime's memory to suit, instantiates the runtime,
// mounts storage, mounts its version's data, installing it first if it isn't
// there yet, deletes other versions' data no host uses, loads the side
// modules, reports storage that isn't what the engine was promised, sets the
// runtime up, then serves requests from the control buffer for good, sleeping
// between them with the next GLib deadline as the timeout, and topping the
// pthread pool up when it runs low. Only this Worker, and the relay it
// starts, touch the runtime's memory.

import { clockStepUs } from "../shared/client.ts";
import {
  controlViews,
  HostOp,
  postCrash,
  postReply,
  requestBytes,
  requestOpcode,
  State,
  Word,
  type BuildConstants,
  type CollectReport,
  type ControlViews,
  type EngineManifest,
  type HostFeatures,
  type HostInit,
  type HostMessage,
  type HostStats,
  type InstallReport,
  type Mount,
  type SideModule,
  type Storage,
  encodeComponent,
  engineDatabase,
  engineDataBytes,
  engineDataDatabase,
  engineDataDatabasePrefix,
  engineDataDir,
  engineDataLock,
  engineDataRoot,
  engineDir,
  engineInstallLock,
  engineWriterLock,
} from "../shared/control.ts";
import type { RelayInit } from "./relay.ts";

// Captured before the runtime is instantiated: under Node, Emscripten
// replaces the global with worker_threads' own Worker class.
const SpawnWorker = Worker;

// What the host uses of ibus-runtime.js's module instance.
interface Runtime {
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _creat(path: number, mode: number): number;
  _write(fd: number, buf: number, count: number): number;
  _fsync(fd: number): number;
  _close(fd: number): number;
  _mkdir(path: number, mode: number): number;
  _wasmfs_create_node_backend(root: number): number;
  _wasmfs_create_memory_backend(): number;
  _wasmfs_create_idb_backend(database: number, flags: number): number;
  _wasmfs_idb_backend_closed(backend: number): number;
  _wasmfs_idb_backend_seal(backend: number): void;
  _wasmfs_create_directory(path: number, mode: number, backend: number): number;
  _ibusweb_runtime_init(wakeWord: number): number;
  _ibusweb_pump(): number;
  _ibusweb_wait(seen: number, timeoutMs: number): number;
  _ibusweb_load_module(path: number, moduleOut: number): number;
  _ibusweb_install_begin(dir: number, installOut: number): number;
  _ibusweb_install_feed(install: number, data: number, len: number): number;
  _ibusweb_install_end(install: number): number;
  _ibusweb_install_count(install: number, files: number, bytes: number): void;
  _ibusweb_dispatch(request: number, requestLen: number, reply: number, replyCap: number): number;
  _mallinfo(out: number): void;
  // Emscripten's own pthread pool, which the runtime exports for the host to
  // top it up.
  PThread: EmscriptenPool;
}

// Emscripten's internals, not an API: requireRuntime() checks they are there.
interface EmscriptenPool {
  // The Workers pthread_create() hands threads to, last first.
  unusedWorkers: Worker[];
  // Creates a Worker for the pool and adds it to unusedWorkers.
  allocateUnusedWorker(): Worker;
  // Sends the Worker the runtime; settles once the Worker has instantiated
  // it and can run a thread.
  loadWasmModuleToWorker(worker: Worker): Promise<Worker>;
}

type InstantiateWasm = (
  imports: WebAssembly.Imports,
  done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
) => object;

type CreateRuntime = (settings: {
  instantiateWasm?: InstantiateWasm;
  wasmMemory?: WebAssembly.Memory;
}) => Promise<Runtime>;

// What Emscripten throws to unwind the runtime's thread once another thread
// has crashed. That thread's own error reaches this one's event loop only
// afterwards, as an uncaught error.
const UNWIND = "unwind";

// ES2024's Atomics.waitAsync(), which the WebWorker library this targets
// doesn't declare.
const waitAsync = (
  Atomics as unknown as {
    waitAsync(
      typedArray: Int32Array,
      index: number,
      value: number,
      timeout: number,
    ): { async: false; value: string } | { async: true; value: Promise<string> };
  }
).waitAsync;

const post = (message: HostMessage): void => self.postMessage(message);

const features = (): HostFeatures => ({
  atomicsWaitAsync: typeof (Atomics as { waitAsync?: unknown }).waitAsync === "function",
  clockStepUs: clockStepUs(() => performance.now()),
});

// In a browser, a thread's uncaught error reaches this thread as the
// ErrorEvent its Worker fired, which Emscripten rethrows.
const describe = (error: unknown): string => {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  if (typeof ErrorEvent === "function" && error instanceof ErrorEvent)
    return `${error.message} (${error.filename}:${error.lineno})`;
  return String(error);
};

const encoder = new TextEncoder();

// The promise's value, or fallback if it takes longer than ms.
const within = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

const WASM_PAGE = 65536;

// A memory the runtime can't take fails the load here, with the bounds,
// rather than as a LinkError from instantiating the runtime, or not at all
// for a size that isn't whole pages, which WebAssembly.Memory rounds down.
const checkMemory = (
  { initial, maximum }: HostInit["memory"],
  { minimum, maximum: most }: BuildConstants["memory"],
): void => {
  const bounds = `a whole number of ${WASM_PAGE}-byte pages from ${minimum} to ${most} bytes`;
  for (const [what, bytes] of [
    ["memory", initial],
    ["memory maximum", maximum],
  ] as const)
    if (!Number.isSafeInteger(bytes) || bytes % WASM_PAGE !== 0 || bytes < minimum || bytes > most)
      throw new Error(`${what} ${bytes}: the runtime takes ${bounds}`);
  if (maximum < initial) throw new Error(`memory maximum ${maximum}: below the memory, ${initial}`);
};

class Heap {
  readonly rt: Runtime;
  // The memory the host made for the runtime. Only a memory that can grow
  // needs it here: when another thread grows it, the views this thread has
  // keep the old length until they are made again from its buffer.
  readonly memory: WebAssembly.Memory;
  #bytes: Uint8Array;
  #words: Int32Array;

  constructor(rt: Runtime, memory: WebAssembly.Memory) {
    this.rt = rt;
    this.memory = memory;
    this.#bytes = rt.HEAPU8;
    this.#words = new Int32Array(this.#bytes.buffer);
  }

  #current(): void {
    const { buffer } = this.memory;
    if (buffer !== this.#bytes.buffer) {
      this.#bytes = new Uint8Array(buffer);
      this.#words = new Int32Array(buffer);
    }
  }

  get bytes(): Uint8Array {
    this.#current();
    return this.#bytes;
  }

  get words(): Int32Array {
    this.#current();
    return this.#words;
  }

  alloc(bytes: number): number {
    const ptr = this.rt._malloc(Math.max(bytes, 1));
    if (ptr === 0) throw new Error(`malloc(${bytes}) failed`);
    return ptr;
  }

  with<T>(data: Uint8Array, use: (ptr: number) => T): T {
    const ptr = this.alloc(data.length);
    this.bytes.set(data, ptr);
    try {
      return use(ptr);
    } finally {
      this.rt._free(ptr);
    }
  }

  withString<T>(text: string, use: (ptr: number) => T): T {
    return this.with(encoder.encode(`${text}\0`), use);
  }
}

const check = (what: string, ret: number): void => {
  if (ret < 0) throw new Error(`${what}: ${ret}`);
};

// A Web Lock this host holds until it calls release().
interface HeldLock {
  release(): void;
  // How long the request waited, and when it was granted, in Date.now()
  // milliseconds.
  waitMs: number;
  lockedAt: number;
}

const lockManager = (name: string): LockManager => {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  if (locks === undefined) throw new Error(`no Web Locks here to take ${name} with`);
  return locks;
};

// The lock once granted, or null if options.ifAvailable and it is held.
const requestLock = (name: string, options: LockOptions, requestedAt: number): Promise<HeldLock | null> =>
  new Promise((resolve, reject) => {
    lockManager(name)
      .request(name, options, (lock) =>
        lock === null
          ? resolve(null)
          : new Promise<void>((release) =>
              resolve({
                release,
                waitMs: performance.now() - requestedAt,
                lockedAt: Date.now(),
              }),
            ),
      )
      .catch(reject);
  });

const LOCK_ROUND_MS = 1000;
// How long a host waits for a lock without word from its holder before it
// gives up rather than never start. A host installing says it is still
// going on a BroadcastChannel named after the lock, at most every
// PROGRESS_MS, and each word starts the wait over, so an install that takes
// longer than this but keeps going holds no one up for good.
const LOCK_LIMIT_MS = 120_000;
const PROGRESS_MS = 1000;

// Requests the lock and resolves once it is held, calling waiting() first
// if it isn't free. With progress, the holder's word on that channel
// extends the wait. Node (24.20) lets go of the locks of a worker_thread
// that is terminated, but grants a request already queued for one only
// once another request for it arrives, so the wait is made of requests of
// LOCK_ROUND_MS each, each made again when the last times out. A Worker
// that ends lets go of its locks, so a host that dies holding one never
// holds it for good.
const holdLock = async (name: string, mode: LockMode, waiting: () => void, progress?: string): Promise<HeldLock> => {
  const requestedAt = performance.now();
  const now = await requestLock(name, { mode, ifAvailable: true }, requestedAt);
  if (now !== null) return now;
  waiting();
  let heard = requestedAt;
  const channel = progress === undefined ? undefined : new BroadcastChannel(progress);
  if (channel !== undefined)
    channel.onmessage = () => {
      heard = performance.now();
    };
  try {
    for (let left = LOCK_LIMIT_MS; left > 0; left = heard + LOCK_LIMIT_MS - performance.now()) {
      const signal = AbortSignal.timeout(Math.min(LOCK_ROUND_MS, left));
      try {
        const held = await requestLock(name, { mode, signal }, requestedAt);
        if (held !== null) return held;
      } catch (error) {
        if ((error as { name?: unknown } | null)?.name !== "TimeoutError") throw error;
      }
    }
  } finally {
    channel?.close();
  }
  throw new Error(`${name}: not granted after ${LOCK_LIMIT_MS} ms without word from the host holding it`);
};

// Says, on the channel, at most every PROGRESS_MS, that this host is still
// installing.
const progressOn = (name: string): { said(): void; close(): void } => {
  const channel = new BroadcastChannel(name);
  let last = 0;
  return {
    said() {
      const now = performance.now();
      if (now - last < PROGRESS_MS) return;
      last = now;
      channel.postMessage(null);
    },
    close: () => channel.close(),
  };
};

// The locks this host holds. A host whose start fails stays alive to say
// why, so it lets go of them all, rather than keep other hosts from
// installing, collecting or writing the engine's user data.
//
// Its runtime, and any engine thread already started, can still write
// through the read-write user backend, and a host that became writer then
// would sweep beside it; so the backend is sealed before the writer lock
// goes. A runtime that can't be called to seal it keeps the writer lock
// until the Worker, and every thread of the runtime with it, is gone.
class Held {
  #locks = new Set<HeldLock>();
  #writer: HeldLock | null = null;
  #seal: (() => void) | null = null;

  add(lock: HeldLock): HeldLock {
    this.#locks.add(lock);
    return lock;
  }

  addWriter(lock: HeldLock): void {
    this.#writer = this.add(lock);
  }

  sealWith(seal: () => void): void {
    this.#seal = seal;
  }

  release(lock: HeldLock): void {
    this.#locks.delete(lock);
    lock.release();
  }

  releaseAll(): void {
    let sealed = true;
    try {
      this.#seal?.();
    } catch {
      sealed = false;
    }
    for (const lock of this.#locks) if (sealed || lock !== this.#writer) lock.release();
    this.#locks.clear();
    this.#writer = null;
    this.#seal = null;
  }
}

// What the host mounts at the engine's directory, decided before the
// runtime's memory is made, since a mount in memory needs a larger one.
// readOnly: another host holds the engine's writer lock.
type StoragePlan =
  | { mount: "none" }
  | { mount: "node"; hostPath: string; readOnly: boolean }
  | { mount: "indexeddb"; database: string; flags: number; readOnly: boolean }
  // Why IndexedDB can't be opened.
  | { mount: "memory"; why: string };

// A spike instrument: an opaque origin's indexedDB.open(), here, in the
// host's realm only.
const withoutIndexedDB = (): void => {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open: () => {
        throw new DOMException("IndexedDB is withheld from this host", "SecurityError");
      },
    },
  });
};

const briefly = (error: unknown): string =>
  error instanceof Error || error instanceof DOMException ? `${error.name}: ${error.message}` : String(error);

// Opens the database if it exists, without creating it: opening a database
// that doesn't exist would create it, empty, at the version the backend
// creates its object stores in, so that creation is aborted, which leaves
// nothing behind. Resolves with the connection, or null if there is no
// such database; a connection closes when another asks for a version
// change, so that it never holds one up.
const openExisting = (database: string): Promise<IDBDatabase | null> =>
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
    return briefly(error);
  }
};

// Whether this host is the one that may change the engine's user data: it
// is if it gets the engine's writer lock at once, and then holds it for as
// long as it runs. Hosts don't queue for it: one that starts while another
// writes stays read-only for good, since a backend can't become writable.
const takeWriterLock = async (engine: EngineManifest, held: Held): Promise<boolean> => {
  const lock = await requestLock(engineWriterLock(engine), { mode: "exclusive", ifAvailable: true }, performance.now());
  if (lock === null) return false;
  held.addWriter(lock);
  return true;
};

const planStorage = async (
  storage: Storage,
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
      if (storage.withoutIndexedDB === true) withoutIndexedDB();
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

// The memory the runtime needs: mounted in memory, the engine's data takes
// its size more, in whole pages.
const memoryFor = (memory: HostInit["memory"], plan: StoragePlan, engine: EngineManifest): HostInit["memory"] => {
  if (plan.mount !== "memory") return memory;
  const data = Math.ceil(engineDataBytes(engine) / WASM_PAGE) * WASM_PAGE;
  return { initial: memory.initial + data, maximum: memory.maximum + data };
};

// What the engine's directory and data are mounted on, and whether an
// IndexedDB connection under either has closed.
interface Mounted {
  mount: Mount;
  closed(): boolean;
}

// What a host under Node uses of node:fs/promises.
interface NodeFs {
  open(
    path: string,
    flags: "w" | "r",
  ): Promise<{
    writeFile(text: string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readdir(path: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

// Only a host under Node is given Node storage, so only it imports this.
const nodeFs = (): Promise<NodeFs> => import("node:fs/promises" as string) as Promise<NodeFs>;

// Under Node, the engine's own files are kept apart from its data.
const nodeUserDir = (hostPath: string): string => `${hostPath}/user`;

// mkdir -p; a directory that exists already fails harmlessly.
const makeDirs = (heap: Heap, path: string): void => {
  const parts = path.split("/").filter((part) => part !== "");
  for (let i = 1; i <= parts.length; i++)
    heap.withString(`/${parts.slice(0, i).join("/")}`, (ptr) => heap.rt._mkdir(ptr, 0o755));
};

// Mounts the backend, which is 0 if it couldn't be made, at dir.
const mountAt = (heap: Heap, backend: number, dir: string, what: string): void => {
  if (backend === 0)
    throw new Error(
      what === "indexeddb"
        ? `storage failed to open ${dir} on IndexedDB although IndexedDB was available; the backend logged the cause to the Worker's stderr/console`
        : `no ${what} backend for ${dir}`,
    );
  check(
    `mount ${dir}`,
    heap.withString(dir, (ptr) => heap.rt._wasmfs_create_directory(ptr, 0o777, backend)),
  );
};

// Mounts the engine's own files at dir, its parents in memory. The
// IndexedDB backend starts a thread of its own, from the pool, that runs
// its calls for good, and blocks this thread while that thread opens the
// database; it reports why it couldn't on stderr.
const mount = async (heap: Heap, plan: StoragePlan, dir: string, held: Held): Promise<{ closed(): boolean }> => {
  if (plan.mount === "none") return { closed: () => false };
  const { rt } = heap;
  makeDirs(heap, dir.slice(0, dir.lastIndexOf("/")));
  let backend: number;
  switch (plan.mount) {
    case "node": {
      const user = nodeUserDir(plan.hostPath);
      await (await nodeFs()).mkdir(user, { recursive: true });
      backend = heap.withString(user, (ptr) => rt._wasmfs_create_node_backend(ptr));
      break;
    }
    case "indexeddb":
      backend = heap.withString(plan.database, (ptr) => rt._wasmfs_create_idb_backend(ptr, plan.flags));
      break;
    case "memory":
      backend = rt._wasmfs_create_memory_backend();
      break;
  }
  mountAt(heap, backend, dir, plan.mount);
  if (plan.mount === "indexeddb" && !plan.readOnly) held.sealWith(() => rt._wasmfs_idb_backend_seal(backend));
  return {
    closed: plan.mount === "indexeddb" ? () => rt._wasmfs_idb_backend_closed(backend) !== 0 : () => false,
  };
};

// Writes each module through the runtime's own libc, so it lands in its file
// system whatever backs it, then loads it.
const loadSides = (heap: Heap, sides: readonly SideModule[]): void => {
  const { rt } = heap;
  const dir = "/sides";
  heap.withString(dir, (ptr) => rt._mkdir(ptr, 0o755));
  for (const { name, bytes } of sides) {
    const path = `${dir}/${name}.wasm`;
    const fd = heap.withString(path, (ptr) => rt._creat(ptr, 0o644));
    check(`creat ${path}`, fd);
    const data = new Uint8Array(bytes);
    const written = heap.with(data, (ptr) => rt._write(fd, ptr, data.length));
    check(`close ${path}`, rt._close(fd));
    if (written !== data.length) throw new Error(`write ${path}: ${written} of ${data.length}`);
    check(
      `load ${name}`,
      heap.withString(path, (ptr) => rt._ibusweb_load_module(ptr, 0)),
    );
  }
};

// The response body reaches the extractor through a buffer of this size in
// the runtime's memory, which also bounds each of the extractor's writes.
const INSTALL_PIECE = 65536;

// An archive that sends nothing for this long fails the install, and with
// it the host's start, rather than keep the install lock for good.
const ARCHIVE_IDLE_MS = 30_000;

// What an install has done: archive bytes fed, and the files and bytes of
// file data written.
interface Tally {
  fed: number;
  files: number;
  bytes: number;
}

// Streams the archive at url into the extractor, unpacking it into dir,
// and adds what it did to tally, calling progressed() as bytes arrive;
// with stallAt, stops for good once that many bytes have been fed in all,
// after calling stalled() with them.
const installArchive = async (
  heap: Heap,
  url: string,
  dir: string,
  tally: Tally,
  stallAt: number | undefined,
  stalled: (bytes: number) => void,
  arrived: () => void,
): Promise<void> => {
  const { rt } = heap;
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const progressed = (): void => {
    clearTimeout(timer);
    timer = setTimeout(
      () => idle.abort(new Error(`fetch ${url}: nothing arrived for ${ARCHIVE_IDLE_MS} ms`)),
      ARCHIVE_IDLE_MS,
    );
  };
  progressed();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let install = 0;
  let done = false;
  // The install's handle, then its count: files, then bytes as a uint64.
  const out = heap.alloc(16);
  const piece = heap.alloc(INSTALL_PIECE);
  try {
    const response = await fetch(url, { signal: idle.signal });
    if (!response.ok || response.body === null) throw new Error(`fetch ${url}: ${response.status}`);
    reader = response.body.getReader();
    makeDirs(heap, dir);
    check(
      `ibusweb_install_begin ${dir}`,
      heap.withString(dir, (ptr) => rt._ibusweb_install_begin(ptr, out)),
    );
    install = heap.words[out / 4]! >>> 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      progressed();
      arrived();
      const { value } = next;
      for (let at = 0; at < value.length; at += INSTALL_PIECE) {
        let part = value.subarray(at, at + INSTALL_PIECE);
        if (stallAt !== undefined && tally.fed + part.length >= stallAt) part = part.subarray(0, stallAt - tally.fed);
        heap.bytes.set(part, piece);
        check(`install ${url} at byte ${tally.fed}`, rt._ibusweb_install_feed(install, piece, part.length));
        tally.fed += part.length;
        if (tally.fed === stallAt) {
          clearTimeout(timer);
          stalled(tally.fed);
          await new Promise<never>(() => {});
        }
      }
    }
    done = true;
    rt._ibusweb_install_count(install, out + 4, out + 8);
    const { words } = heap;
    const files = words[(out + 4) / 4]! >>> 0;
    const bytes = (words[(out + 8) / 4]! >>> 0) + (words[(out + 12) / 4]! >>> 0) * 2 ** 32;
    const ended = rt._ibusweb_install_end(install);
    install = 0;
    check(`install ${url}`, ended);
    tally.files += files;
    tally.bytes += bytes;
  } finally {
    clearTimeout(timer);
    if (install !== 0) rt._ibusweb_install_end(install);
    rt._free(piece);
    rt._free(out);
    if (reader !== undefined && !done) reader.cancel().catch(() => {});
  }
};

// Installs every archive of the engine's data under its data directory.
const installArchives = async (
  heap: Heap,
  engine: EngineManifest,
  stallAt: number | undefined,
  stalled: (bytes: number) => void,
  arrived: () => void = () => {},
): Promise<Tally> => {
  const tally: Tally = { fed: 0, files: 0, bytes: 0 };
  for (const data of engine.data)
    await installArchive(heap, data.url, engineDataDir(engine, data), tally, stallAt, stalled, arrived);
  return tally;
};

// The marker of a version's data installed whole.
interface Marker {
  version: string;
  files: number;
  bytes: number;
}

const markerFor = (value: unknown, version: string): boolean =>
  typeof value === "object" && value !== null && (value as Partial<Marker>).version === version;

// Where a mount that outlives the Worker keeps each version's data, apart
// from the engine's own files: an IndexedDB database, or a directory on the
// host, per version. A version's data is installed into storage emptied
// first, and its marker is written last, so that data with a marker is
// whole and the version's alone. Once marked, the data is read-only to the
// engine where the backend can refuse changes, as the IndexedDB backend
// can; the Node backend has no read-only mode, nor has the memory
// fallback, so there the engine is trusted not to write its data.
interface DataStore {
  // Whether this version's data was installed whole. The marker is read
  // before the data is mounted, so that a store about to be emptied has no
  // connection of this host's open.
  installed(): Promise<boolean>;
  // Empties this version's storage.
  clear(): Promise<void>;
  // A backend over this version's storage, or 0. The Node backend has no
  // read-only mode.
  backend(readOnly: boolean): number;
  // Marks this version's data installed, durably, once the data is.
  mark(marker: Marker): Promise<void>;
  // Refuses every later change through the backend, where it can.
  seal(): void;
  // Every other version whose data is kept, encoded.
  others(): Promise<string[]>;
  remove(version: string): Promise<void>;
  closed(): boolean;
}

// How long the deletion of a database may stay blocked. Every connection
// the runtime makes closes when another asks to delete its database, so a
// deletion stays blocked only behind one that doesn't.
const DELETE_LIMIT_MS = 10_000;

const deleteDatabase = (name: string): Promise<void> =>
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
              `deleting ${name}: another connection to it stayed open for ${DELETE_LIMIT_MS} ms after it was asked to close`,
            ),
          ),
        DELETE_LIMIT_MS,
      );
    };
  });

// The key of the marker in the database's meta store. The store is the
// backend's, which reads only its own keys; the host writes this one on a
// connection of its own, after every file of the data has been fsync()ed,
// that is committed.
const MARKER_KEY = "installed";

const idbRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const idbStore = (heap: Heap, engine: EngineManifest, readOnlyFlag: number): DataStore => {
  const database = engineDataDatabase(engine);
  const prefix = engineDataDatabasePrefix(engine);
  let backend = 0;
  return {
    async installed() {
      const db = await openExisting(database);
      if (db === null) return false;
      try {
        if (!db.objectStoreNames.contains("meta")) return false;
        const marker = await idbRequest(db.transaction("meta", "readonly").objectStore("meta").get(MARKER_KEY));
        return markerFor(marker, engine.version);
      } finally {
        db.close();
      }
    },
    clear: () => deleteDatabase(database),
    backend(readOnly) {
      backend = heap.withString(database, (ptr) =>
        heap.rt._wasmfs_create_idb_backend(ptr, readOnly ? readOnlyFlag : 0),
      );
      return backend;
    },
    // Every file was fsync()ed, so the data is committed. The directory
    // entries made after a file's last fsync() were committed relaxed; this
    // commit's strict durability flushes them too, since a strict commit
    // makes every earlier change to the database durable.
    async mark(marker) {
      const db = await openExisting(database);
      if (db === null) throw new Error(`${database} is gone`);
      try {
        const tx = db.transaction("meta", "readwrite", {
          durability: "strict",
        });
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
    async others() {
      return (await indexedDB.databases())
        .map(({ name }) => name ?? "")
        .filter((name) => name.startsWith(prefix))
        .map((name) => name.slice(prefix.length))
        .filter((version) => version !== "" && !version.includes("/") && `${prefix}${version}` !== database);
    },
    remove: (version) => deleteDatabase(`${prefix}${version}`),
    seal() {
      if (backend !== 0) heap.rt._wasmfs_idb_backend_seal(backend);
    },
    closed: () => backend !== 0 && heap.rt._wasmfs_idb_backend_closed(backend) !== 0,
  };
};

const nodeStore = async (heap: Heap, engine: EngineManifest, hostPath: string): Promise<DataStore> => {
  const fs = await nodeFs();
  const root = `${hostPath}/data`;
  const own = encodeComponent(engine.version);
  const dirOf = (version: string): string => `${root}/${version}`;
  // Beside the version's directory, outside the tree the engine sees; the
  // marker is written whole as the second file, then renamed over the first.
  const MARKER = ".installed";
  const PENDING = ".marking";
  const markerOf = (version: string): string => `${dirOf(version)}${MARKER}`;
  const pendingOf = (version: string): string => `${dirOf(version)}${PENDING}`;
  // The marker goes first, so that a removal cut short leaves no marker.
  const remove = async (version: string): Promise<void> => {
    for (const path of [markerOf(version), pendingOf(version), dirOf(version)])
      await fs.rm(path, { recursive: true, force: true });
  };
  return {
    // A marker that doesn't parse is none, so the version is installed
    // again rather than every start failing.
    async installed() {
      try {
        return markerFor(JSON.parse(await fs.readFile(markerOf(own), "utf8")), engine.version);
      } catch {
        return false;
      }
    },
    async clear() {
      await remove(own);
      await fs.mkdir(dirOf(own), { recursive: true });
    },
    backend: () => heap.withString(dirOf(own), (ptr) => heap.rt._wasmfs_create_node_backend(ptr)),
    // Every file of the data was fsync()ed before this is written. The
    // rename makes the marker whole or absent, and syncing the directory,
    // where the platform allows it, makes the rename durable.
    async mark(marker) {
      const file = await fs.open(pendingOf(own), "w");
      try {
        await file.writeFile(JSON.stringify(marker));
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(pendingOf(own), markerOf(own));
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
    seal: () => {},
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

// Deletes the data of every other version no host is using. A host using a
// version holds its data lock shared, so one granted exclusively at once
// is one no host uses, and no host can start using it until it is let go.
// Best-effort: a failure is reported, never thrown.
const collect = async (store: DataStore, engine: EngineManifest): Promise<CollectReport> => {
  const report: CollectReport = { removed: [], inUse: [] };
  try {
    for (const version of await store.others()) {
      const lock = await requestLock(
        engineDataLock(engine, version),
        { mode: "exclusive", ifAvailable: true },
        performance.now(),
      );
      if (lock === null) {
        report.inUse.push(version);
        continue;
      }
      try {
        await store.remove(version);
        report.removed.push(version);
      } finally {
        lock.release();
      }
    }
  } catch (error) {
    report.error = briefly(error);
  }
  return report;
};

// Mounts this version's data at the engine's data directory, installing
// it first unless its marker says it is there, then lets other versions'
// data go. A mount in memory is this host's alone and starts empty, so it
// installs with no lock. Otherwise the host holds the version's data lock,
// shared, for as long as it runs, and decides and installs under its
// install lock, so that of hosts starting together one installs and the
// others then find the marker. An install cut short leaves no marker, and
// the next host empties the version's storage and installs again, so no
// partial tree and no other version's file survives, and a host using
// another version never sees its own data change.
//
// The host that installs keeps its read-write backend mounted and seals it
// once the marker is durable, rather than mount a read-only one as well,
// since a backend's thread lasts as long as the runtime.
const provideData = async (
  heap: Heap,
  init: HostInit<WebAssembly.Module>,
  plan: StoragePlan,
  held: Held,
): Promise<() => boolean> => {
  const { engine, installStallAt } = init;
  if (plan.mount === "none") return () => false;
  if (engine.version === "") throw new Error(`engine ${engine.name}'s manifest has no version`);
  const root = engineDataRoot(engine);
  const startedAt = performance.now();
  const stalled =
    (lock: Pick<HeldLock, "waitMs" | "lockedAt">) =>
    (bytes: number): void =>
      post({
        type: "install",
        state: "stalled",
        version: engine.version,
        lockWaitMs: lock.waitMs,
        lockedAt: lock.lockedAt,
        releasedAt: 0,
        bytes,
        installMs: performance.now() - startedAt,
      });
  if (plan.mount === "memory") {
    makeDirs(heap, root);
    const lock = { waitMs: 0, lockedAt: Date.now() };
    const { fed: bytes } = await installArchives(heap, engine, installStallAt, stalled(lock));
    post({
      type: "install",
      state: "installed",
      version: engine.version,
      lockWaitMs: lock.waitMs,
      lockedAt: lock.lockedAt,
      releasedAt: Date.now(),
      bytes,
      installMs: performance.now() - startedAt,
    });
    return () => false;
  }

  const waiting = (lock: string) => (): void => post({ type: "waiting", lock });
  const dataLock = engineDataLock(engine, encodeComponent(engine.version));
  held.add(await holdLock(dataLock, "shared", waiting(dataLock)));
  const installLock = engineInstallLock(engine);
  const lock = held.add(await holdLock(installLock, "exclusive", waiting(installLock), installLock));
  const store =
    plan.mount === "node"
      ? await nodeStore(heap, engine, plan.hostPath)
      : idbStore(heap, engine, init.constants.idbReadOnly);
  const what = plan.mount;
  let state: InstallReport["state"];
  let bytes = 0;
  if (await store.installed()) {
    mountAt(heap, store.backend(true), root, what);
    state = "present";
  } else {
    await store.clear();
    mountAt(heap, store.backend(false), root, what);
    const progress = progressOn(installLock);
    try {
      const tally = await installArchives(heap, engine, installStallAt, stalled(lock), progress.said);
      bytes = tally.fed;
      await store.mark({
        version: engine.version,
        files: tally.files,
        bytes: tally.bytes,
      });
    } finally {
      progress.close();
    }
    store.seal();
    state = "installed";
  }
  // Read before letting go, so that a host waiting on the lock can't take
  // it at an earlier time than this.
  const releasedAt = Date.now();
  held.release(lock);
  post({
    type: "install",
    state,
    version: engine.version,
    lockWaitMs: lock.waitMs,
    lockedAt: lock.lockedAt,
    releasedAt,
    bytes,
    installMs: performance.now() - startedAt,
  });
  post({ type: "collect", ...(await collect(store, engine)) });
  return () => store.closed();
};

// Resolves once the relay has started; a failure after that only reaches
// this thread's event loop, which a sleeping host doesn't run, so the relay
// also reports one through the control buffer.
const startRelay = (init: RelayInit): Promise<Worker> =>
  new Promise((resolve, reject) => {
    const relay = new SpawnWorker(new URL("./relay.js", import.meta.url), {
      type: "module",
      name: "ibus-web-relay",
    });
    relay.onmessage = () => resolve(relay);
    relay.onerror = (event) => reject(new Error(`relay: ${event.message}`));
    relay.postMessage(init);
  });

// A spike instrument: counts the Workers Emscripten creates, through the
// global Worker class. Under Node, Emscripten first assigns worker_threads'
// Worker to the global, so the global becomes an accessor that wraps
// whichever class it is given.
interface Workers {
  // Created since counting started.
  created: number;
  counting: boolean;
}

const trackWorkers = (): Workers => {
  const workers: Workers = { created: 0, counting: false };
  const wrap = (Base: typeof Worker): typeof Worker =>
    class extends Base {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        if (workers.counting) workers.created++;
      }
    };
  let current = wrap(globalThis.Worker);
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    get: () => current,
    set: (Base: typeof Worker) => {
      current = wrap(Base);
    },
  });
  return workers;
};

// Long enough that the loop reaches the messages already queued for it, not
// only the timer.
const yieldToEventLoop = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const heapInUse = (heap: Heap, constants: BuildConstants, scratch: number): number => {
  heap.rt._mallinfo(scratch);
  return heap.words[(scratch + constants.mallinfo.inUseOffset) / 4]!;
};

const pump = (rt: Runtime, constants: BuildConstants): number => {
  const delay = rt._ibusweb_pump();
  if (delay === constants.pumpError) throw new Error("pumped off the runtime's thread");
  return delay;
};

// Spike instruments: what HostOp.stats reports beyond the Workers.
interface Counters {
  requests: number;
  requestsWhileAsleep: number;
  topUps: number;
  topUpWorkers: number;
  lastTopUpMs: number | null;
  lastTopUpCreateMs: number | null;
  eventLoopTurns: number;
}

// pthread_create() fails with EAGAIN rather than wait for a Worker beyond
// the pool: a browser starts a new Worker, or in Firefox even creates one,
// only while the thread creating it is back in its event loop, which a host
// that sleeps in the runtime isn't. The pool starts with lowWater Workers
// beyond the threads its shares plan for, so fewer than lowWater are idle
// only once more threads are alive than planned. Whenever that is so and no
// request is pending, the host adds Workers to make up lowWater and stays in
// its event loop, still serving requests, until they have loaded.
interface Pool {
  lowWater: number;
  // A spike instrument: HostOp.topUp holds top-ups off.
  held: boolean;
  // Set once a top-up has failed; another would most likely fail the same
  // way.
  failed: boolean;
  topping: Promise<void> | null;
}

// Far longer than a top-up takes, under 0.2 s, and than the page's spin,
// which holds back a Worker's new Worker() in Firefox.
const TOP_UP_LIMIT_MS = 10_000;

// Rejects if the Workers haven't all loaded within TOP_UP_LIMIT_MS; any that
// load later still join the pool.
const topUp = (rt: Runtime, want: number, counters: Counters): Promise<void> => {
  const { PThread } = rt;
  const startedAt = performance.now();
  const loading: Promise<void>[] = [];
  for (let i = 0; i < want; i++) {
    // pthread_create() hands out any Worker in the pool, and one that hasn't
    // started yet wouldn't start while the host then blocks, so a new Worker
    // joins the pool only once it has loaded.
    const worker = PThread.allocateUnusedWorker();
    const index = PThread.unusedWorkers.indexOf(worker);
    if (index < 0) throw new Error("PThread.allocateUnusedWorker() didn't add its Worker to PThread.unusedWorkers");
    PThread.unusedWorkers.splice(index, 1);
    loading.push(
      PThread.loadWasmModuleToWorker(worker).then(() => {
        PThread.unusedWorkers.push(worker);
      }),
    );
  }
  const createMs = performance.now() - startedAt;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`pool top-up: ${want} Workers not all loaded in ${TOP_UP_LIMIT_MS} ms`)),
      TOP_UP_LIMIT_MS,
    );
  });
  return Promise.race([Promise.all(loading), late])
    .then(() => {
      counters.topUps++;
      counters.topUpWorkers += want;
      counters.lastTopUpMs = performance.now() - startedAt;
      counters.lastTopUpCreateMs = createMs;
    })
    .finally(() => clearTimeout(timer));
};

// The host leans on Emscripten internals that a new Emscripten may rename or
// drop; better to refuse to start than to fail at the first top-up.
const requireRuntime = (rt: Runtime): void => {
  const pool = (rt as Partial<Runtime>).PThread as Partial<EmscriptenPool> | undefined;
  const missing = [
    ...(rt.HEAPU8 instanceof Uint8Array ? [] : ["HEAPU8"]),
    ...(Array.isArray(pool?.unusedWorkers) ? [] : ["PThread.unusedWorkers"]),
    ...(typeof pool?.allocateUnusedWorker === "function" ? [] : ["PThread.allocateUnusedWorker"]),
    ...(typeof pool?.loadWasmModuleToWorker === "function" ? [] : ["PThread.loadWasmModuleToWorker"]),
  ];
  if (missing.length > 0) throw new Error(`the runtime lacks what the host uses of it: ${missing.join(", ")}`);
};

// Answers the request in the slot. Only HostOp.yield answers later, after
// the returned promise settles.
const serve = (
  heap: Heap,
  control: ControlViews,
  constants: BuildConstants,
  buffers: { request: number; reply: number; cap: number; mallinfo: number },
  workers: Workers,
  pool: Pool,
  counters: Counters,
  mounted: Mounted,
): Promise<void> | undefined => {
  const request = requestBytes(control);
  const arg = (fallback: number): number =>
    request.length >= 8 ? new DataView(request.buffer, request.byteOffset + 4).getInt32(0, true) : fallback;
  if (request.length >= 4) {
    switch (requestOpcode(request)) {
      case HostOp.stats: {
        const stats: HostStats = {
          workersCreated: workers.created,
          idleWorkers: heap.rt.PThread.unusedWorkers.length,
          heapInUse: heapInUse(heap, constants, buffers.mallinfo),
          memoryBytes: heap.bytes.byteLength,
          mount: mounted.mount,
          storageClosed: mounted.closed(),
          ...counters,
        };
        const json = encoder.encode(JSON.stringify(stats));
        postReply(control, json.length, json);
        return undefined;
      }
      case HostOp.yield:
        counters.eventLoopTurns++;
        return yieldToEventLoop(arg(10)).then(() => postReply(control, 0));
      case HostOp.topUp:
        pool.held = arg(1) === 0;
        postReply(control, 0);
        return undefined;
      case HostOp.addWorkers:
        counters.eventLoopTurns++;
        return topUp(heap.rt, arg(1), counters).then(
          () => postReply(control, 0),
          (error: unknown) => {
            post({ type: "error", message: describe(error) });
            postReply(control, -1);
          },
        );
    }
  }
  heap.bytes.set(request, buffers.request);
  const ret = heap.rt._ibusweb_dispatch(buffers.request, request.length, buffers.reply, buffers.cap);
  pump(heap.rt, constants);
  postReply(control, ret, ret > 0 ? heap.bytes.subarray(buffers.reply, buffers.reply + ret) : undefined);
  return undefined;
};

// Why the runtime stopped. When Emscripten unwound this thread for another
// thread's crash, that is the other thread's error, once this thread's
// event loop has delivered it.
const crashCause = async (error: unknown): Promise<string> => {
  if (error !== UNWIND) return describe(error);
  const uncaught = new Promise<string>((resolve) => {
    self.addEventListener("error", (event) => {
      event.preventDefault();
      resolve(describe(event.error ?? event.message));
    });
  });
  return `a thread crashed: ${await within(uncaught, 1000, "its error never arrived")}`;
};

// The runtime, instantiated in a memory made for it, with the engine's
// directory mounted and its data installed.
interface Brought {
  rt: Runtime;
  heap: Heap;
  workers: Workers;
  mounted: Mounted;
}

const bringUp = async (
  init: HostInit<WebAssembly.Module>,
  createRuntime: CreateRuntime,
  plan: StoragePlan,
  held: Held,
): Promise<Brought> => {
  const { constants } = init;
  const memoryBytes = memoryFor(init.memory, plan, init.engine);
  checkMemory(memoryBytes, constants.memory);
  const workers = trackWorkers();
  const { wasm } = init;
  const memory = new WebAssembly.Memory({
    initial: memoryBytes.initial / WASM_PAGE,
    maximum: memoryBytes.maximum / WASM_PAGE,
    shared: true,
  });
  // Emscripten has no way to hear that instantiateWasm failed, so a failure
  // ends the wait for the runtime here instead.
  let failInstantiate: (error: unknown) => void = () => {};
  const instantiateFailed = new Promise<never>((_, reject) => {
    failInstantiate = reject;
  });
  const rt = await Promise.race([
    createRuntime({
      wasmMemory: memory,
      ...(wasm === undefined
        ? {}
        : {
            instantiateWasm: (imports, done) => {
              WebAssembly.instantiate(wasm, imports).then((instance) => done(instance, wasm), failInstantiate);
              return {};
            },
          }),
    }),
    instantiateFailed,
  ]);
  workers.counting = true;
  requireRuntime(rt);
  const heap = new Heap(rt, memory);

  const user = await mount(heap, plan, engineDir(init.engine), held);
  if (plan.mount === "memory") post({ type: "storage", state: "ephemeral", message: plan.why });
  if ((plan.mount === "indexeddb" || plan.mount === "node") && plan.readOnly)
    post({
      type: "storage",
      state: "read-only",
      message: `another instance of engine ${init.engine.name} holds ${engineWriterLock(init.engine)}; this one's user data refuses changes${plan.mount === "node" ? " (in browsers; the Node backend has no read-only mode)" : ""}`,
    });
  const dataClosed = await provideData(heap, init, plan, held);
  const mounted: Mounted = {
    mount: plan.mount,
    closed: () => user.closed() || dataClosed(),
  };
  return { rt, heap, workers, mounted };
};

const start = async (init: HostInit<WebAssembly.Module>): Promise<void> => {
  const startedAt = performance.now();
  const control = controlViews(init.control);
  const { default: createRuntime } = (await import(init.runtimeUrl)) as {
    default: CreateRuntime;
  };
  const held = new Held();
  try {
    await serveFrom(init, control, startedAt, createRuntime, held);
  } catch (error) {
    held.releaseAll();
    throw error;
  }
};

// Starts the runtime and serves requests for good. A host that fails to
// start stays alive to say why, so its caller lets go of its locks.
const serveFrom = async (
  init: HostInit<WebAssembly.Module>,
  control: ControlViews,
  startedAt: number,
  createRuntime: CreateRuntime,
  held: Held,
): Promise<void> => {
  const { constants } = init;
  const plan = await planStorage(init.storage, init.engine, constants.idbReadOnly, held);
  const { rt, heap, workers, mounted } = await bringUp(init, createRuntime, plan, held);
  loadSides(heap, init.sides);

  const wake = heap.alloc(4);
  const wakeIndex = wake / 4;
  Atomics.store(heap.words, wakeIndex, 0);
  check("ibusweb_runtime_init", rt._ibusweb_runtime_init(wake));

  // The relay bridges the one word the host doesn't sleep on to the one it
  // does.
  const runtimeWord = {
    buffer: heap.bytes.buffer as SharedArrayBuffer,
    index: wakeIndex,
  };
  const controlWord = { buffer: init.control, index: Word.wake };
  const relay = await startRelay({
    ...(init.wait === "control" ? { from: runtimeWord, to: controlWord } : { from: controlWord, to: runtimeWord }),
    control: init.control,
  });
  // Each word is read before the state and the pump look, so a wake that
  // lands after them changes it and the sleep returns at once.
  const [sleepWords, sleepIndex] = init.wait === "control" ? [control.words, Word.wake] : [heap.words, wakeIndex];
  const relayFailed = new Promise<string>((resolve) => {
    relay.onerror = (event) => {
      resolve(event.message);
      postCrash(control);
      Atomics.add(sleepWords, sleepIndex, 1);
      Atomics.notify(sleepWords, sleepIndex);
    };
  });

  const cap = control.slot.length;
  const buffers = {
    request: heap.alloc(cap),
    reply: heap.alloc(cap),
    cap,
    mallinfo: heap.alloc(constants.mallinfo.bytes),
  };
  const counters: Counters = {
    requests: 0,
    requestsWhileAsleep: 0,
    topUps: 0,
    topUpWorkers: 0,
    lastTopUpMs: null,
    lastTopUpCreateMs: null,
    eventLoopTurns: 0,
  };
  const pool: Pool = {
    lowWater: init.poolLowWater,
    held: false,
    failed: false,
    topping: null,
  };
  const startupMs = performance.now() - startedAt;
  post({ type: "ready", startupMs, features: features() });

  // Whether the last wait ended with its word changed, which is how a
  // request that arrives while the host sleeps wakes it. ibusweb_wait()
  // can't tell a word that changed before it slept from one that changed
  // during, so in "runtime" mode the word is read once more just before the
  // call: a change before that read doesn't count. One that lands between
  // that read and the futex wait inside the call, a window of a few
  // instructions, still does.
  let woken = false;
  // The page hears of it once, when the host next wakes.
  let closedReported = false;
  try {
    for (;;) {
      if (!closedReported && mounted.closed()) {
        closedReported = true;
        post({
          type: "storage",
          state: "closed",
          message: "the IndexedDB connection closed; the engine's storage fails with EIO",
        });
      }
      const seen = Atomics.load(sleepWords, sleepIndex);
      const state = Atomics.load(control.words, Word.state);
      if (state === State.crashed)
        throw new Error(`relay: ${await within(relayFailed, 1000, "stopped without an error")}`);
      if (state === State.request) {
        counters.requests++;
        if (woken) counters.requestsWhileAsleep++;
        woken = false;
        const later = serve(heap, control, constants, buffers, workers, pool, counters, mounted);
        if (later !== undefined) await later;
        continue;
      }
      woken = false;
      const delay = pump(rt, constants);
      const after = Atomics.load(control.words, Word.state);
      if (after === State.request || after === State.crashed) continue;
      const timeout = delay < 0 ? Infinity : delay;
      const idle = rt.PThread.unusedWorkers.length;
      if (pool.topping === null && !pool.held && !pool.failed && idle < pool.lowWater) {
        counters.eventLoopTurns++;
        pool.topping = topUp(rt, pool.lowWater - idle, counters)
          .catch((error: unknown) => {
            pool.failed = true;
            post({ type: "error", message: describe(error) });
          })
          .finally(() => {
            pool.topping = null;
          });
      }
      if (pool.topping !== null) {
        const result = waitAsync(sleepWords, sleepIndex, seen, timeout);
        woken = (result.async ? await Promise.race([result.value, pool.topping]) : result.value) === "ok";
        continue;
      }
      switch (init.wait) {
        case "runtime": {
          const unmoved = Atomics.load(heap.words, wakeIndex) === seen;
          const ret = rt._ibusweb_wait(seen, delay);
          if (ret < 0 && ret !== constants.waitTimedOut) throw new Error(`ibusweb_wait: ${ret}`);
          woken = unmoved && ret === 0;
          break;
        }
        case "runtime-async": {
          const result = waitAsync(heap.words, wakeIndex, seen, timeout);
          woken = (result.async ? await result.value : result.value) === "ok";
          break;
        }
        case "control":
          woken = Atomics.wait(control.words, Word.wake, seen, timeout) === "ok";
      }
    }
  } catch (error) {
    postCrash(control);
    relay.terminate();
    held.releaseAll();
    post({ type: "crashed", message: await crashCause(error) });
  }
};

self.onmessage = ({ data }: MessageEvent<HostInit<WebAssembly.Module>>) => {
  self.onmessage = null;
  start(data).catch((error: unknown) => post({ type: "error", message: describe(error) }));
};
