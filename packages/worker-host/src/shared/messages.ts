// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the page and the Worker host say to each other by postMessage: the
// host's one message in, and every message out.

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

export interface SideModule {
  name: string;
  bytes: ArrayBuffer;
}

// Values the runtime's build defines, which the host checks its calls
// against, and the bounds of the memory the runtime takes.
export interface RuntimeConstants {
  // IBUSWEB_PUMP_ERROR.
  pumpError: number;
  // ibusweb_wait()'s -ETIMEDOUT.
  waitTimedOut: number;
  // The least and the most memory the runtime's memory import admits, in
  // bytes.
  memory: { minimum: number; maximum: number };
}

// The page's first and only message to the host. Wasm is the runtime's
// compiled WebAssembly.Module, typed by the environment that has one. Test
// is read only by the host's test build; the host as released ignores it.
export interface HostInit<Wasm = unknown, Test = never> {
  // The runtime's ibus-runtime.js, which the host imports.
  runtimeUrl: string;
  wasm?: Wasm;
  // The runtime's memory, in bytes, which the host makes and passes to it:
  // initial is the engine manifest's memory. The runtime as released never
  // grows it, whatever the maximum.
  memory: { initial: number; maximum: number };
  control: SharedArrayBuffer;
  // The engine's side modules, loaded in this order.
  sides: readonly SideModule[];
  engine: EngineManifest;
  // The host tops Emscripten's pthread pool up, when no request is pending,
  // to this many idle Workers.
  poolLowWater: number;
  constants: RuntimeConstants;
  test?: Test;
}

// The state of the engine's storage, when it isn't what the engine was
// promised: "ephemeral", mounted in memory for want of IndexedDB, so user
// data lasts only as long as the Worker; "read-only", another host holds the
// engine's writer lock, so this one's user data refuses changes with EROFS
// for as long as it runs; "closed", the IndexedDB backend's connection closed
// under it, so every later call that reaches the database fails with EIO.
export type StorageState = "ephemeral" | "read-only" | "closed";

// Effect's log levels, by name.
export type LogLevel = "All" | "Fatal" | "Error" | "Warn" | "Info" | "Debug" | "Trace" | "None";

export type HostMessage =
  // The host serves requests from here on.
  | { type: "ready"; startupMs: number }
  | { type: "storage"; state: StorageState; message: string }
  | { type: "log"; level: LogLevel; message: string }
  // The host failed to start; it serves nothing.
  | { type: "error"; message: string }
  // The runtime stopped after the host was ready: the control buffer says
  // CRASHED, and this says why.
  | { type: "crashed"; message: string };
