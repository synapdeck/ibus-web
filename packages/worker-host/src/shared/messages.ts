// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the page and the Worker host say to each other by postMessage: the
// host's one message in, and every message out.

import type { TransportLayout } from "@ibus-web/protocol/transport";
import type { EngineManifest } from "@ibus-web/protocol";
export type { EngineManifest } from "@ibus-web/protocol";
export type EngineData = EngineManifest["data"][number];
export interface RuntimeMemory {
  initial: number;
  maximum: number;
}

// The engine's data's size, unpacked.
export const engineDataBytes = ({ data }: Pick<EngineManifest, "data">): number =>
  data.reduce((sum, { size }) => sum + size, 0);

// The page size of WebAssembly memory, in bytes.
export const WASM_PAGE = 65536;

// The runtime's memory, initial and maximum, when the engine's data sits in
// it: the data's size more, in whole pages.
export const memoryWithData = (
  { initial, maximum }: { initial: number; maximum: number },
  engine: Pick<EngineManifest, "data">,
): { initial: number; maximum: number } => {
  const data = Math.ceil(engineDataBytes(engine) / WASM_PAGE) * WASM_PAGE;
  return { initial: initial + data, maximum: maximum + data };
};

export interface SideModule {
  name: string;
  bytes: ArrayBuffer;
}

// Values the runtime's build defines, which the host checks its calls
// against, and the bounds of the memory the runtime takes.
export interface RuntimeConstants {
  runtimeAbi: number;
  protocol: number;
  canceled: number;
  // IBUSWEB_PUMP_ERROR.
  pumpError: number;
  // ibusweb_wait()'s -ETIMEDOUT.
  waitTimedOut: number;
  // WASMFS_IDB_READ_ONLY.
  idbReadOnly: number;
  // The least and the most memory the runtime's memory import admits, in
  // bytes.
  memory: { minimum: number; maximum: number };
}

// What the host mounts at the engine's directory, /engines/<name>, for the
// engine's own files.
export type EngineStorage =
  // Nothing: the engine has no directory.
  | { kind: "none" }
  // WasmFS's Node backend over user/ in hostPath, a directory on the host
  // kept for the engine. Only a host under Node can mount it.
  | { kind: "node"; hostPath: string }
  // The engine's IndexedDB database or, where IndexedDB can't be opened,
  // memory.
  | { kind: "browser" };

// The page's first and only message to the host. Wasm is the runtime's
// compiled WebAssembly.Module, typed by the environment that has one. Test
// is read only by the host's test build; the host as released ignores it.
export type HostInit<Wasm = unknown, Test = never> = {
  // The runtime's ibus-runtime.js, which the host imports.
  runtimeUrl: string;
  wasm?: Wasm;
  control: SharedArrayBuffer;
  layout?: TransportLayout;
  storage: EngineStorage;
  // The host tops Emscripten's pthread pool up, when no request is pending,
  // to this many idle Workers.
  poolLowWater: number;
  constants: RuntimeConstants;
  test?: Test;
} & ({ manifest: EngineManifest; manifestUrl?: never } | { manifest?: never; manifestUrl: string });

// What the host mounts the engine's own files on: "memory" for want of
// IndexedDB.
export type Mount = "none" | "node" | "indexeddb" | "memory";

// The state of the engine's storage, when it isn't what the engine was
// promised: "ephemeral", mounted in memory for want of IndexedDB, so user
// data lasts only as long as the Worker; "read-only", another host holds the
// engine's writer lock, so this one's user data refuses changes with EROFS
// for as long as it runs; "closed", the IndexedDB backend's connection closed
// under it, so every later call that reaches the database fails with EIO.
export type StorageState = "ephemeral" | "read-only" | "closed";

// How the host found the engine's data at start: "installed", it installed
// it; "present", the version's data was installed already. files and bytes
// are the regular files and the bytes of file data the install wrote, as
// its marker records them. lockWaitMs is how long the host waited for the
// version's install lock; lockedAt and releasedAt, when it took and let go
// of it, in Date.now() milliseconds, which hosts share; installMs, from
// the first lock request to the report. A mount in memory installs at
// every start, with no lock.
export interface InstallReport {
  state: "installed" | "present";
  version: string;
  files: number;
  bytes: number;
  lockWaitMs: number;
  lockedAt: number;
  releasedAt: number;
  installMs: number;
}

// What the host did with other versions' data once its own was mounted:
// the encoded versions it deleted, those another host still uses, and why
// it couldn't look or delete, if it couldn't. Collecting never fails a
// start.
export interface CollectReport {
  removed: string[];
  inUse: string[];
  error?: string;
}

export type HostMessage =
  | { type: "doorbell" }
  // The host serves requests from here on.
  | { type: "ready"; startupMs: number }
  | { type: "storage"; state: StorageState; message: string }
  | ({ type: "install" } & InstallReport)
  | ({ type: "collect" } & CollectReport)
  // The host failed to start; it serves nothing.
  | { type: "error"; message: string }
  // The runtime stopped after the host was ready: the control buffer says
  // CRASHED, and this says why.
  | { type: "crashed"; message: string };
