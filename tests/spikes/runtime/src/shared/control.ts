// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The dedicated control SharedArrayBuffer between the page and the Worker
// host: a header of Int32 words, then one slot that carries the request and
// then its reply. The page only ever touches this buffer, never the runtime's
// memory.

export const HEADER_BYTES = 64;
export const DEFAULT_SLOT_BYTES = 64 * 1024;

// Word indices in the header.
export const Word = {
  // One of State.
  state: 0,
  // Incremented by the page for each request.
  reqSeq: 1,
  // The request's length in the slot.
  reqLen: 2,
  // ibusweb_dispatch()'s return value: the reply's length in the slot, or a
  // negative errno.
  replyRet: 3,
  // The word the host sleeps on: the page increments it and notifies after
  // posting a request.
  wake: 4,
} as const;

export const State = {
  idle: 0,
  request: 1,
  reply: 2,
  crashed: 3,
} as const;

// Spike instruments, not protocol: requests the spike's host answers itself,
// outside the runtime's opcode space, so scenarios can observe and steer it.
// A real host has neither.
export const HostOp = {
  // A UTF-8 JSON HostStats.
  stats: 0xffff_0001,
  // Returns the host to its event loop for the int32 payload's milliseconds
  // (10 if none), then replies 0.
  yield: 0xffff_0002,
  // Holds off topping the pool up while the int32 payload is 0, and allows
  // it again otherwise; replies 0.
  topUp: 0xffff_0003,
  // Adds the int32 payload's count of Workers to the pool, then replies 0
  // once they have all loaded the runtime, or -1.
  addWorkers: 0xffff_0004,
} as const;

// A spike instrument: what HostOp.stats reports.
export interface HostStats {
  // Workers Emscripten created after the runtime started, beyond its pool.
  workersCreated: number;
  // Workers in Emscripten's pool that host no thread and can take one.
  idleWorkers: number;
  // Pool top-ups finished, the Workers they added, and how long the last
  // took from its first new Worker to its last one loaded.
  topUps: number;
  topUpWorkers: number;
  lastTopUpMs: number | null;
  // Of that, how long the last top-up's new Worker() calls took.
  lastTopUpCreateMs: number | null;
  // Times the host has left ibusweb_wait() for its event loop: a top-up or
  // a yield.
  eventLoopTurns: number;
  // Bytes malloc() has handed out and not had back.
  heapInUse: number;
  // The runtime's memory's size.
  memoryBytes: number;
  // What backs the engine's directory: "memory" is the in-memory mount of a
  // host without IndexedDB.
  mount: Mount;
  // Whether the IndexedDB backend's connection has closed under it.
  storageClosed: boolean;
  // Requests the host has served, this one included.
  requests: number;
  // Of those, the ones that arrived while the host slept: it found them
  // when its wait returned rather than before starting one.
  requestsWhileAsleep: number;
}

// Values the C side defines, printed by the build for the WebAssembly
// target, and the bounds of the memory the runtime takes, from its build.
export interface BuildConstants {
  // The spike side modules' opcodes, by their C names without SPIKE_OP_.
  ops: Readonly<Record<string, number>>;
  // IBUSWEB_PUMP_ERROR.
  pumpError: number;
  // ibusweb_wait()'s -ETIMEDOUT.
  waitTimedOut: number;
  // WASMFS_IDB_READ_ONLY.
  idbReadOnly: number;
  // struct mallinfo's size, and the offset of uordblks (bytes in use).
  mallinfo: { bytes: number; inUseOffset: number };
  // The least and the most memory the runtime's memory import admits, in
  // bytes.
  memory: { minimum: number; maximum: number };
}

// How the host sleeps between requests.
//  - "runtime": in ibusweb_wait(), on a word in the runtime's memory that
//    GLib's wake hook bumps; a relay Worker bumps it for the page.
//  - "runtime-async": in Atomics.waitAsync() on that same word, so the
//    host's event loop runs while it is idle.
//  - "control": in Atomics.wait() on Word.wake, which the page bumps, so a
//    request reaches the host without the relay; a relay Worker bumps the
//    word for GLib's wake hook instead. This is the relay-less comparison
//    for the request path, not a design: the host's sleep runs no proxied
//    calls.
export type WaitMode = "runtime" | "runtime-async" | "control";

// What the host mounts at its engine's directory, /engines/<name>, for the
// engine's own files, and at its data directory, /engines/<name>/data, for
// the data its version installs.
export type Storage =
  // Nothing: the engine's directory doesn't exist.
  | { kind: "none" }
  // WasmFS's Node backend over directories in hostPath, the engine's
  // directory on the host: user/ for its own files, and data/<version>/
  // for each version's data.
  | { kind: "node"; hostPath: string }
  // The engine's IndexedDB databases, through the runtime's IndexedDB
  // backend, or, where IndexedDB can't be opened, WasmFS's memory backend.
  // withoutIndexedDB is a spike instrument: indexedDB.open() throws in the
  // host, as it does in an opaque origin.
  | { kind: "browser"; withoutIndexedDB?: boolean };

// An archive of the engine's data: where the host fetches it (an absolute
// URL), the directory it unpacks to as the engine sees it, and its size
// once unpacked, in bytes.
export interface EngineData {
  url: string;
  path: string;
  size: number;
}

// What the host reads of an engine's manifest: the engine's name, its
// version, which its installed data is marked with, and its data.
export interface EngineManifest {
  name: string;
  version: string;
  data: readonly EngineData[];
}

// The spike's stand-in for an engine's manifest, without data; harnesses
// that have the test archive add it with withData().
export const SPIKE_ENGINE: EngineManifest = {
  name: "spike",
  version: "0",
  data: [],
};

// A test archive as its build describes it: its file name, a version
// derived from its bytes, its unpacked size and the listing an installed
// tree matches.
export interface TestArchive {
  archive: string;
  version: string;
  size: number;
  listing: string;
}

// The test archives (tree.json): the engine's data, and the next version's,
// which drops a file and turns another into a directory.
export interface TestData extends TestArchive {
  upgrade: TestArchive;
}

// The directory the spike's engine expects its data at.
export const SPIKE_DATA_PATH = "/usr/share/spike";

// The engine with the test archive, fetched from url, as its data, and the
// archive's version as its own.
export const withData = (
  engine: EngineManifest,
  data: TestArchive,
  url: string,
): EngineManifest => ({
  ...engine,
  version: data.version,
  data: [{ url, path: SPIKE_DATA_PATH, size: data.size }],
});

export const engineDir = ({ name }: EngineManifest): string =>
  `/engines/${name}`;

// Where the engine's data is mounted, apart from its own files.
export const engineDataRoot = (engine: EngineManifest): string =>
  `${engineDir(engine)}/data`;

// Where an archive's data lands: under the data's mount, at the path the
// engine expects it.
export const engineDataDir = (
  engine: EngineManifest,
  { path }: EngineData,
): string => `${engineDataRoot(engine)}${path}`;

// A name or version as it appears in database, lock and directory names:
// no "/", no ":", and never "." or "..", so that one engine's or version's
// names never run into another's.
export const encodeComponent = (text: string): string =>
  encodeURIComponent(text).replace(
    /[!'()*.~]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

// The IndexedDB database the engine's own files live in.
export const engineDatabase = ({ name }: EngineManifest): string =>
  `ibus-web/${encodeComponent(name)}`;

// The prefix of the IndexedDB databases that hold the engine's data, one
// per version; the encoded version follows it.
export const engineDataDatabasePrefix = (engine: EngineManifest): string =>
  `${engineDatabase(engine)}/data/`;

export const engineDataDatabase = (engine: EngineManifest): string =>
  `${engineDataDatabasePrefix(engine)}${encodeComponent(engine.version)}`;

// The Web Lock a version's data is installed under, held exclusively.
export const engineInstallLock = (engine: EngineManifest): string =>
  `ibus-web:install:${encodeComponent(engine.name)}:${encodeComponent(engine.version)}`;

// The Web Lock the one host that may change the engine's user data holds,
// for as long as it runs; every other host mounts that data read-only.
export const engineWriterLock = ({ name }: EngineManifest): string =>
  `ibus-web:writer:${encodeComponent(name)}`;

// The Web Lock every host using a version's data holds, shared, for as long
// as it runs; a host takes it exclusively to delete that version's data.
export const engineDataLock = (
  { name }: EngineManifest,
  encodedVersion: string,
): string => `ibus-web:data:${encodeComponent(name)}:${encodedVersion}`;

// The engine's data's size: what the host adds to the runtime's memory when
// the data sits in it.
export const engineDataBytes = ({ data }: EngineManifest): number =>
  data.reduce((sum, { size }) => sum + size, 0);

export interface SideModule {
  name: string;
  bytes: ArrayBuffer;
}

// The page's first and only message to the host. Wasm is the runtime's
// compiled WebAssembly.Module, typed by the environment that has one.
export interface HostInit<Wasm = unknown> {
  runtimeUrl: string;
  // The host tops Emscripten's pthread pool up, when no request is pending,
  // to this many idle Workers.
  poolLowWater: number;
  wasm?: Wasm;
  // The runtime's memory, in bytes, which the host makes and passes to it,
  // since the runtime won't start without one: initial plays the engine
  // manifest's memory. A maximum above it lets a runtime linked with growth
  // grow; the runtime as released never grows.
  memory: { initial: number; maximum: number };
  control: SharedArrayBuffer;
  sides: SideModule[];
  engine: EngineManifest;
  storage: Storage;
  wait: WaitMode;
  constants: BuildConstants;
  // A spike instrument: the host stops installing, for good, once it has fed
  // the extractor this many bytes of the engine's data, and reports
  // install: stalled.
  installStallAt?: number;
}

export type Mount = "none" | "node" | "indexeddb" | "memory";

// A spike instrument: what the host's Worker offers that the host or
// Emscripten's runtime relies on, and the step its performance.now() takes.
export interface HostFeatures {
  atomicsWaitAsync: boolean;
  clockStepUs: number;
}

// The state of the engine's storage, when it isn't what the engine was
// promised: "ephemeral", mounted in memory for want of IndexedDB, so user
// data lasts only as long as the Worker; "read-only", another host holds the
// engine's writer lock, so this one's user data refuses changes with EROFS
// for as long as it runs; "closed", the IndexedDB backend's connection closed
// under it, so every later call that reaches the database fails with EIO.
export type StorageState = "ephemeral" | "read-only" | "closed";

// How the host found the engine's data at start: "installed", it installed
// it; "present", the version's data was installed already; "stalled", the
// install stopped where HostInit.installStallAt said.
// lockWaitMs is how long the host waited for the install lock; lockedAt and
// releasedAt, when it took and let go of it, in Date.now() milliseconds,
// which hosts share; bytes, the archive bytes fed.
export interface InstallReport {
  state: "installed" | "present" | "stalled";
  version: string;
  lockWaitMs: number;
  lockedAt: number;
  releasedAt: number;
  bytes: number;
  installMs: number;
}

// What the host did with other versions' data once its own was mounted:
// the encoded versions it deleted, those another host still uses, and why
// it couldn't look, if it couldn't.
export interface CollectReport {
  removed: string[];
  inUse: string[];
  error?: string;
}

export type HostMessage =
  | { type: "ready"; startupMs: number; features: HostFeatures }
  | { type: "storage"; state: StorageState; message: string }
  | ({ type: "install" } & InstallReport)
  | ({ type: "collect" } & CollectReport)
  // A spike instrument: the host's request for the lock wasn't granted at
  // once, so it is waiting.
  | { type: "waiting"; lock: string }
  | { type: "error"; message: string }
  | { type: "crashed"; message: string };

export interface ControlViews {
  words: Int32Array;
  slot: Uint8Array;
}

export const createControl = (
  slotBytes = DEFAULT_SLOT_BYTES,
): SharedArrayBuffer => new SharedArrayBuffer(HEADER_BYTES + slotBytes);

export const controlViews = (buffer: SharedArrayBuffer): ControlViews => ({
  words: new Int32Array(buffer, 0, HEADER_BYTES / 4),
  slot: new Uint8Array(buffer, HEADER_BYTES),
});

// A little-endian uint32 opcode, then the payload.
export const encodeRequest = (
  opcode: number,
  payload: Uint8Array = new Uint8Array(),
): Uint8Array => {
  const request = new Uint8Array(4 + payload.length);
  new DataView(request.buffer).setUint32(0, opcode, true);
  request.set(payload, 4);
  return request;
};

export const requestOpcode = (request: Uint8Array): number =>
  new DataView(
    request.buffer,
    request.byteOffset,
    request.byteLength,
  ).getUint32(0, true);

// Page side: the slot must be free (State.idle or a taken reply).
export const postRequest = (
  { words, slot }: ControlViews,
  request: Uint8Array,
): void => {
  if (request.length > slot.length)
    throw new RangeError(`request of ${request.length} bytes`);
  slot.set(request);
  Atomics.store(words, Word.reqLen, request.length);
  Atomics.add(words, Word.reqSeq, 1);
  Atomics.store(words, Word.state, State.request);
  Atomics.add(words, Word.wake, 1);
  Atomics.notify(words, Word.wake);
};

export interface Reply {
  ret: number;
  bytes: Uint8Array;
}

// Page side, once the state is State.reply: copies the reply out and frees
// the slot.
export const takeReply = ({ words, slot }: ControlViews): Reply => {
  const ret = Atomics.load(words, Word.replyRet);
  const bytes = ret > 0 ? slot.slice(0, ret) : new Uint8Array();
  Atomics.store(words, Word.state, State.idle);
  return { ret, bytes };
};

// Host side, once the state is State.request: the request, still in the slot.
export const requestBytes = ({ words, slot }: ControlViews): Uint8Array =>
  slot.subarray(0, Atomics.load(words, Word.reqLen));

// Host side: reply bytes, or nothing when ret is an error.
export const postReply = (
  { words, slot }: ControlViews,
  ret: number,
  bytes?: Uint8Array,
): void => {
  if (bytes !== undefined) slot.set(bytes);
  Atomics.store(words, Word.replyRet, ret);
  Atomics.store(words, Word.state, State.reply);
  Atomics.notify(words, Word.state);
};

export const postCrash = ({ words }: ControlViews): void => {
  Atomics.store(words, Word.state, State.crashed);
  Atomics.notify(words, Word.state);
};
