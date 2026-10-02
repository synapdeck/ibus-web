// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The spike's Worker host. Its one message is a HostInit: it decides what to
// mount at its engine's directory, makes the runtime's memory to suit,
// instantiates the runtime, mounts storage, installs the engine's data if
// this version's isn't there yet, loads the side modules, reports storage
// that isn't what the engine was promised, sets the runtime up, then
// serves requests from the control buffer for good, sleeping between them
// with the next GLib deadline as the timeout, and topping the pthread pool
// up when it runs low. Only this Worker, and the relay it starts, touch the
// runtime's memory.

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
  type ControlViews,
  type HostFeatures,
  type HostInit,
  type HostMessage,
  type HostStats,
  type InstallReport,
  type Mount,
  type SideModule,
  type Storage,
  engineDatabase,
  engineDataBytes,
  engineDataDir,
  engineDir,
  engineInstallLock,
  engineMarker,
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
  // open()'s third argument is where its variadic mode is.
  _open(path: number, flags: number, varargs: number): number;
  _read(fd: number, buf: number, count: number): number;
  _write(fd: number, buf: number, count: number): number;
  _fsync(fd: number): number;
  _close(fd: number): number;
  _mkdir(path: number, mode: number): number;
  _wasmfs_create_node_backend(root: number): number;
  _wasmfs_create_memory_backend(): number;
  _wasmfs_create_idb_backend(database: number, flags: number): number;
  _wasmfs_idb_backend_closed(backend: number): number;
  _wasmfs_create_directory(path: number, mode: number, backend: number): number;
  _ibusweb_runtime_init(wakeWord: number): number;
  _ibusweb_pump(): number;
  _ibusweb_wait(seen: number, timeoutMs: number): number;
  _ibusweb_load_module(path: number, moduleOut: number): number;
  _ibusweb_install_begin(dir: number, installOut: number): number;
  _ibusweb_install_feed(install: number, data: number, len: number): number;
  _ibusweb_install_end(install: number): number;
  _ibusweb_dispatch(
    request: number,
    requestLen: number,
    reply: number,
    replyCap: number,
  ): number;
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
    ):
      { async: false; value: string } | { async: true; value: Promise<string> };
  }
).waitAsync;

const post = (message: HostMessage): void => self.postMessage(message);

const features = (): HostFeatures => ({
  atomicsWaitAsync:
    typeof (Atomics as { waitAsync?: unknown }).waitAsync === "function",
  clockStepUs: clockStepUs(() => performance.now()),
});

// In a browser, a thread's uncaught error reaches this thread as the
// ErrorEvent its Worker fired, which Emscripten rethrows.
const describe = (error: unknown): string => {
  if (error instanceof Error)
    return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  if (typeof ErrorEvent === "function" && error instanceof ErrorEvent)
    return `${error.message} (${error.filename}:${error.lineno})`;
  return String(error);
};

const encoder = new TextEncoder();

// The promise's value, or fallback if it takes longer than ms.
const within = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);

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
    if (
      !Number.isSafeInteger(bytes) ||
      bytes % WASM_PAGE !== 0 ||
      bytes < minimum ||
      bytes > most
    )
      throw new Error(`${what} ${bytes}: the runtime takes ${bounds}`);
  if (maximum < initial)
    throw new Error(`memory maximum ${maximum}: below the memory, ${initial}`);
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

// Requests the lock and resolves once it is held. A Worker that ends lets go
// of its locks, so a host that dies mid-install never holds one for good.
const holdLock = async (name: string): Promise<HeldLock> => {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)
    ?.locks;
  if (locks === undefined)
    throw new Error(`no Web Locks here to take ${name} with`);
  const requestedAt = performance.now();
  return new Promise<HeldLock>((resolve, reject) => {
    locks
      .request(
        name,
        () =>
          new Promise<void>((release) =>
            resolve({
              release,
              waitMs: performance.now() - requestedAt,
              lockedAt: Date.now(),
            }),
          ),
      )
      .catch(reject);
  });
};

// What the host mounts at the engine's directory, decided before the
// runtime's memory is made, since a mount in memory needs a larger one. A
// mount that outlives the Worker comes with the engine's install lock held.
type StoragePlan =
  | { mount: "none" }
  | { mount: "node"; hostPath: string; installLock: HeldLock }
  | {
      mount: "indexeddb";
      database: string;
      flags: number;
      installLock: HeldLock;
    }
  // Why IndexedDB can't be opened.
  | { mount: "memory"; why: string };

// A spike instrument: an opaque origin's indexedDB.open(), here, in the
// host's realm only.
const withoutIndexedDB = (): void => {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open: () => {
        throw new DOMException(
          "IndexedDB is withheld from this host",
          "SecurityError",
        );
      },
    },
  });
};

const briefly = (error: unknown): string =>
  error instanceof Error || error instanceof DOMException
    ? `${error.name}: ${error.message}`
    : String(error);

// Whether IndexedDB opens the database: null if it does, or why not. The
// backend opens its own connection, on its own thread, so this one closes
// at once, before it can hold up another's version change. Opening a
// database that doesn't exist would create it, empty, at the version the
// backend creates its object stores in, so the probe aborts that creation,
// which leaves nothing behind.
const probeIndexedDB = (database: string): Promise<string | null> =>
  new Promise((resolve) => {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (factory === undefined) {
      resolve("this environment has no IndexedDB");
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(database);
    } catch (error) {
      resolve(briefly(error));
      return;
    }
    let creating = false;
    request.onupgradeneeded = () => {
      creating = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      request.result.close();
      resolve(null);
    };
    request.onerror = (event) => {
      event.preventDefault();
      resolve(
        creating && request.error?.name === "AbortError"
          ? null
          : briefly(request.error),
      );
    };
  });

const planStorage = async (
  storage: Storage,
  engine: HostInit["engine"],
): Promise<StoragePlan> => {
  switch (storage.kind) {
    case "none":
      return { mount: "none" };
    case "node":
      return {
        mount: "node",
        hostPath: storage.hostPath,
        installLock: await holdLock(engineInstallLock(engine)),
      };
    case "browser": {
      if (storage.withoutIndexedDB === true) withoutIndexedDB();
      const database = engineDatabase(engine);
      const why = await probeIndexedDB(database);
      if (why !== null) return { mount: "memory", why };
      // Taken before anything about the database is decided and held until
      // the engine's data is installed, so that hosts starting together
      // decide and install one at a time.
      const installLock = await holdLock(engineInstallLock(engine));
      // The flags are decided before the backend exists because creating it
      // sweeps the database of what a crash left behind, which needs
      // exclusive write access to the database.
      return { mount: "indexeddb", database, flags: 0, installLock };
    }
  }
};

// The memory the runtime needs: mounted in memory, the engine's data takes
// its size more, in whole pages.
const memoryFor = (
  memory: HostInit["memory"],
  plan: StoragePlan,
  engine: HostInit["engine"],
): HostInit["memory"] => {
  if (plan.mount !== "memory") return memory;
  const data = Math.ceil(engineDataBytes(engine) / WASM_PAGE) * WASM_PAGE;
  return { initial: memory.initial + data, maximum: memory.maximum + data };
};

// The engine's directory as mounted, and whether IndexedDB's connection has
// closed under it.
interface Mounted {
  mount: Mount;
  closed(): boolean;
}

const mount = (heap: Heap, plan: StoragePlan, dir: string): Mounted => {
  if (plan.mount === "none") return { mount: "none", closed: () => false };
  const { rt } = heap;
  // Its parents, in memory; one that exists already fails harmlessly.
  const parts = dir.split("/").filter((part) => part !== "");
  for (let i = 1; i < parts.length; i++)
    heap.withString(`/${parts.slice(0, i).join("/")}`, (ptr) =>
      rt._mkdir(ptr, 0o755),
    );
  // The IndexedDB backend starts a thread of its own, from the pool, that
  // runs its calls for good, and blocks this thread while that thread opens
  // the database; it reports why it couldn't on stderr.
  let backend: number;
  switch (plan.mount) {
    case "node":
      backend = heap.withString(plan.hostPath, (ptr) =>
        rt._wasmfs_create_node_backend(ptr),
      );
      break;
    case "indexeddb":
      backend = heap.withString(plan.database, (ptr) =>
        rt._wasmfs_create_idb_backend(ptr, plan.flags),
      );
      break;
    case "memory":
      backend = rt._wasmfs_create_memory_backend();
      break;
  }
  if (backend === 0)
    throw new Error(
      plan.mount === "indexeddb"
        ? `storage failed to open ${dir} on IndexedDB although IndexedDB was available; the backend logged the cause to the Worker's stderr/console`
        : `no ${plan.mount} backend for ${dir}`,
    );
  check(
    `mount ${dir}`,
    heap.withString(dir, (ptr) =>
      rt._wasmfs_create_directory(ptr, 0o777, backend),
    ),
  );
  return {
    mount: plan.mount,
    closed:
      plan.mount === "indexeddb"
        ? () => rt._wasmfs_idb_backend_closed(backend) !== 0
        : () => false,
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
    if (written !== data.length)
      throw new Error(`write ${path}: ${written} of ${data.length}`);
    check(
      `load ${name}`,
      heap.withString(path, (ptr) => rt._ibusweb_load_module(ptr, 0)),
    );
  }
};

const O_RDONLY = 0;

// The file's contents as text, or null if it can't be read.
const readText = (heap: Heap, path: string, most: number): string | null => {
  const { rt } = heap;
  const fd = heap.withString(path, (ptr) => rt._open(ptr, O_RDONLY, 0));
  if (fd < 0) return null;
  const buf = heap.alloc(most);
  try {
    const got = rt._read(fd, buf, most);
    return got < 0
      ? null
      : new TextDecoder().decode(heap.bytes.slice(buf, buf + got));
  } finally {
    rt._free(buf);
    rt._close(fd);
  }
};

// Creates or truncates the file, writes text, fsync()s and closes it.
const writeSynced = (heap: Heap, path: string, text: string): void => {
  const { rt } = heap;
  const fd = heap.withString(path, (ptr) => rt._creat(ptr, 0o644));
  check(`creat ${path}`, fd);
  const data = encoder.encode(text);
  try {
    const written = heap.with(data, (ptr) => rt._write(fd, ptr, data.length));
    if (written !== data.length)
      throw new Error(`write ${path}: ${written} of ${data.length}`);
    check(`fsync ${path}`, rt._fsync(fd));
  } finally {
    rt._close(fd);
  }
};

// mkdir -p; a directory that exists already fails harmlessly.
const makeDirs = (heap: Heap, path: string): void => {
  const parts = path.split("/").filter((part) => part !== "");
  for (let i = 1; i <= parts.length; i++)
    heap.withString(`/${parts.slice(0, i).join("/")}`, (ptr) =>
      heap.rt._mkdir(ptr, 0o755),
    );
};

// The response body reaches the extractor through a buffer of this size in
// the runtime's memory, which also bounds each of the extractor's writes.
const INSTALL_PIECE = 65536;

// Streams the archive at url into the extractor, unpacking it into dir.
// Returns the bytes fed; with stallAt, stops for good once that many have
// been, after calling stalled() with them.
const installArchive = async (
  heap: Heap,
  url: string,
  dir: string,
  fed: number,
  stallAt: number | undefined,
  stalled: (bytes: number) => void,
): Promise<number> => {
  const { rt } = heap;
  const response = await fetch(url);
  if (!response.ok || response.body === null)
    throw new Error(`fetch ${url}: ${response.status}`);
  const reader = response.body.getReader();
  makeDirs(heap, dir);
  const out = heap.alloc(4);
  const piece = heap.alloc(INSTALL_PIECE);
  let install = 0;
  try {
    check(
      `ibusweb_install_begin ${dir}`,
      heap.withString(dir, (ptr) => rt._ibusweb_install_begin(ptr, out)),
    );
    install = heap.words[out / 4]! >>> 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let at = 0; at < value.length; at += INSTALL_PIECE) {
        let part = value.subarray(at, at + INSTALL_PIECE);
        if (stallAt !== undefined && fed + part.length >= stallAt)
          part = part.subarray(0, stallAt - fed);
        heap.bytes.set(part, piece);
        check(
          `install ${url} at byte ${fed}`,
          rt._ibusweb_install_feed(install, piece, part.length),
        );
        fed += part.length;
        if (fed === stallAt) {
          stalled(fed);
          await new Promise<never>(() => {});
        }
      }
    }
    const ended = rt._ibusweb_install_end(install);
    install = 0;
    check(`install ${url}`, ended);
    return fed;
  } finally {
    if (install !== 0) rt._ibusweb_install_end(install);
    rt._free(piece);
    rt._free(out);
    reader.releaseLock();
  }
};

// Installs the engine's data unless the marker says this version's is
// there, then writes the marker, last, so that an install cut short leaves
// none and the next host to start does it again.
const installData = async (
  heap: Heap,
  engine: HostInit["engine"],
  lock: Pick<HeldLock, "waitMs" | "lockedAt">,
  stallAt: number | undefined,
): Promise<InstallReport> => {
  const startedAt = performance.now();
  const marker = engineMarker(engine);
  const report = (state: InstallReport["state"], bytes: number) => ({
    state,
    version: engine.version,
    lockWaitMs: lock.waitMs,
    lockedAt: lock.lockedAt,
    releasedAt: 0,
    bytes,
    installMs: performance.now() - startedAt,
  });
  // A version longer than this is no version this host wrote.
  const markerMost = engine.version.length * 4 + 1;
  if (readText(heap, marker, markerMost) === engine.version)
    return report("present", 0);
  let fed = 0;
  for (const data of engine.data)
    fed = await installArchive(
      heap,
      data.url,
      engineDataDir(engine, data),
      fed,
      stallAt,
      (bytes) => post({ type: "install", ...report("stalled", bytes) }),
    );
  writeSynced(heap, marker, engine.version);
  return report("installed", fed);
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
const yieldToEventLoop = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const heapInUse = (
  heap: Heap,
  constants: BuildConstants,
  scratch: number,
): number => {
  heap.rt._mallinfo(scratch);
  return heap.words[(scratch + constants.mallinfo.inUseOffset) / 4]!;
};

const pump = (rt: Runtime, constants: BuildConstants): number => {
  const delay = rt._ibusweb_pump();
  if (delay === constants.pumpError)
    throw new Error("pumped off the runtime's thread");
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
const topUp = (
  rt: Runtime,
  want: number,
  counters: Counters,
): Promise<void> => {
  const { PThread } = rt;
  const startedAt = performance.now();
  const loading: Promise<void>[] = [];
  for (let i = 0; i < want; i++) {
    // pthread_create() hands out any Worker in the pool, and one that hasn't
    // started yet wouldn't start while the host then blocks, so a new Worker
    // joins the pool only once it has loaded.
    const worker = PThread.allocateUnusedWorker();
    const index = PThread.unusedWorkers.indexOf(worker);
    if (index < 0)
      throw new Error(
        "PThread.allocateUnusedWorker() didn't add its Worker to PThread.unusedWorkers",
      );
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
      () =>
        reject(
          new Error(
            `pool top-up: ${want} Workers not all loaded in ${TOP_UP_LIMIT_MS} ms`,
          ),
        ),
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
  const pool = (rt as Partial<Runtime>).PThread as
    Partial<EmscriptenPool> | undefined;
  const missing = [
    ...(rt.HEAPU8 instanceof Uint8Array ? [] : ["HEAPU8"]),
    ...(Array.isArray(pool?.unusedWorkers) ? [] : ["PThread.unusedWorkers"]),
    ...(typeof pool?.allocateUnusedWorker === "function"
      ? []
      : ["PThread.allocateUnusedWorker"]),
    ...(typeof pool?.loadWasmModuleToWorker === "function"
      ? []
      : ["PThread.loadWasmModuleToWorker"]),
  ];
  if (missing.length > 0)
    throw new Error(
      `the runtime lacks what the host uses of it: ${missing.join(", ")}`,
    );
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
    request.length >= 8
      ? new DataView(request.buffer, request.byteOffset + 4).getInt32(0, true)
      : fallback;
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
  const ret = heap.rt._ibusweb_dispatch(
    buffers.request,
    request.length,
    buffers.reply,
    buffers.cap,
  );
  pump(heap.rt, constants);
  postReply(
    control,
    ret,
    ret > 0
      ? heap.bytes.subarray(buffers.reply, buffers.reply + ret)
      : undefined,
  );
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
              WebAssembly.instantiate(wasm, imports).then(
                (instance) => done(instance, wasm),
                failInstantiate,
              );
              return {};
            },
          }),
    }),
    instantiateFailed,
  ]);
  workers.counting = true;
  requireRuntime(rt);
  const heap = new Heap(rt, memory);

  const mounted = mount(heap, plan, engineDir(init.engine));
  if (plan.mount === "memory")
    post({ type: "storage", state: "ephemeral", message: plan.why });
  if (plan.mount !== "none") {
    // A mount in memory is this host's alone and starts empty.
    const lock =
      plan.mount === "memory"
        ? { waitMs: 0, lockedAt: Date.now() }
        : plan.installLock;
    const report = await installData(
      heap,
      init.engine,
      lock,
      init.installStallAt,
    );
    // Read before letting go, so that a host waiting on the lock can't take
    // it at an earlier time than this.
    const releasedAt = Date.now();
    if ("release" in lock) lock.release();
    post({ type: "install", ...report, releasedAt });
  }
  return { rt, heap, workers, mounted };
};

const start = async (init: HostInit<WebAssembly.Module>): Promise<void> => {
  const startedAt = performance.now();
  const control = controlViews(init.control);
  const { constants } = init;
  const { default: createRuntime } = (await import(init.runtimeUrl)) as {
    default: CreateRuntime;
  };
  const plan = await planStorage(init.storage, init.engine);
  let brought: Brought;
  try {
    brought = await bringUp(init, createRuntime, plan);
  } catch (error) {
    // A host that fails to start stays alive to report it, and mustn't keep
    // the next one from installing.
    if ("installLock" in plan) plan.installLock.release();
    throw error;
  }
  const { rt, heap, workers, mounted } = brought;
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
    ...(init.wait === "control"
      ? { from: runtimeWord, to: controlWord }
      : { from: controlWord, to: runtimeWord }),
    control: init.control,
  });
  // Each word is read before the state and the pump look, so a wake that
  // lands after them changes it and the sleep returns at once.
  const [sleepWords, sleepIndex] =
    init.wait === "control"
      ? [control.words, Word.wake]
      : [heap.words, wakeIndex];
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
          message:
            "the IndexedDB connection closed; the engine's storage fails with EIO",
        });
      }
      const seen = Atomics.load(sleepWords, sleepIndex);
      const state = Atomics.load(control.words, Word.state);
      if (state === State.crashed)
        throw new Error(
          `relay: ${await within(relayFailed, 1000, "stopped without an error")}`,
        );
      if (state === State.request) {
        counters.requests++;
        if (woken) counters.requestsWhileAsleep++;
        woken = false;
        const later = serve(
          heap,
          control,
          constants,
          buffers,
          workers,
          pool,
          counters,
          mounted,
        );
        if (later !== undefined) await later;
        continue;
      }
      woken = false;
      const delay = pump(rt, constants);
      const after = Atomics.load(control.words, Word.state);
      if (after === State.request || after === State.crashed) continue;
      const timeout = delay < 0 ? Infinity : delay;
      const idle = rt.PThread.unusedWorkers.length;
      if (
        pool.topping === null &&
        !pool.held &&
        !pool.failed &&
        idle < pool.lowWater
      ) {
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
        woken =
          (result.async
            ? await Promise.race([result.value, pool.topping])
            : result.value) === "ok";
        continue;
      }
      switch (init.wait) {
        case "runtime": {
          const unmoved = Atomics.load(heap.words, wakeIndex) === seen;
          const ret = rt._ibusweb_wait(seen, delay);
          if (ret < 0 && ret !== constants.waitTimedOut)
            throw new Error(`ibusweb_wait: ${ret}`);
          woken = unmoved && ret === 0;
          break;
        }
        case "runtime-async": {
          const result = waitAsync(heap.words, wakeIndex, seen, timeout);
          woken = (result.async ? await result.value : result.value) === "ok";
          break;
        }
        case "control":
          woken =
            Atomics.wait(control.words, Word.wake, seen, timeout) === "ok";
      }
    }
  } catch (error) {
    postCrash(control);
    relay.terminate();
    post({ type: "crashed", message: await crashCause(error) });
  }
};

self.onmessage = ({ data }: MessageEvent<HostInit<WebAssembly.Module>>) => {
  self.onmessage = null;
  start(data).catch((error: unknown) =>
    post({ type: "error", message: describe(error) }),
  );
};
