// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the host uses of ibus-runtime.js, and the plain functions that call
// into it.

import { WASM_PAGE, type RuntimeMemory, type SideModule, type RuntimeConstants } from "../shared/messages.ts";

// A failure that leaves the runtime fit to be called again: a call into it
// returned an error, or the host refused something before calling it.
// Anything else thrown out of a block that calls into the runtime may have
// come from inside it.
export class RuntimeRefused extends Error {}

// What the host uses of the runtime's module instance.
export interface Runtime {
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _creat(path: number, mode: number): number;
  _write(fd: number, buf: number, count: number): number;
  _close(fd: number): number;
  _setenv(name: number, value: number, overwrite: number): number;
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
  _ibusweb_dispatch(request: number, requestLen: number): number;
  _ibusweb_output_peek(length: number): number;
  _ibusweb_output_consume(length: number): void;
  _ibusweb_output_last_seq(): number;
  _ibusweb_install_begin(dir: number, installOut: number): number;
  _ibusweb_install_feed(install: number, data: number, len: number): number;
  _ibusweb_install_count(install: number, files: number, bytes: number): void;
  _ibusweb_install_end(install: number): number;
  // Emscripten's own pthread pool, which the runtime exports for the host to
  // top it up.
  PThread: EmscriptenPool;
}

// Emscripten's internals, not an API: requireRuntime() checks they are there.
export interface EmscriptenPool {
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

export type CreateRuntime = (settings: {
  instantiateWasm?: InstantiateWasm;
  wasmMemory?: WebAssembly.Memory;
  ibuswebEngineThreads: number;
}) => Promise<Runtime>;

// The runtime started in the memory the host made for it, with its views of
// that memory. The memory never grows, so the views stay whole.
export interface RuntimeHandle {
  rt: Runtime;
  memory: WebAssembly.Memory;
  bytes: Uint8Array;
  words: Int32Array;
}

// A memory the runtime can't take fails the load here, with the bounds,
// rather than as a LinkError from instantiating the runtime, or not at all
// for a size that isn't whole pages, which WebAssembly.Memory rounds down.
export const checkMemory = (
  { initial, maximum }: RuntimeMemory,
  { minimum, maximum: most }: RuntimeConstants["memory"],
): void => {
  const bounds = `a whole number of ${WASM_PAGE}-byte pages from ${minimum} to ${most} bytes`;
  for (const [what, bytes] of [
    ["memory", initial],
    ["memory maximum", maximum],
  ] as const)
    if (!Number.isSafeInteger(bytes) || bytes % WASM_PAGE !== 0 || bytes < minimum || bytes > most)
      throw new RuntimeRefused(`${what} ${bytes}: the runtime takes ${bounds}`);
  if (maximum < initial) throw new RuntimeRefused(`memory maximum ${maximum}: below the memory, ${initial}`);
};

// The host leans on Emscripten internals that a new Emscripten may rename or
// drop; better to refuse to start than to fail at the first top-up.
export const requireRuntime = (rt: Runtime): void => {
  const pool = (rt as Partial<Runtime>).PThread as Partial<EmscriptenPool> | undefined;
  const missing = [
    ...(rt.HEAPU8 instanceof Uint8Array ? [] : ["HEAPU8"]),
    ...(Array.isArray(pool?.unusedWorkers) ? [] : ["PThread.unusedWorkers"]),
    ...(typeof pool?.allocateUnusedWorker === "function" ? [] : ["PThread.allocateUnusedWorker"]),
    ...(typeof pool?.loadWasmModuleToWorker === "function" ? [] : ["PThread.loadWasmModuleToWorker"]),
  ];
  if (missing.length > 0) throw new RuntimeRefused(`the runtime lacks what the host uses of it: ${missing.join(", ")}`);
};

export const check = (what: string, ret: number): void => {
  if (ret < 0) throw new RuntimeRefused(`${what}: ${ret}`);
};

const encoder = new TextEncoder();

export const alloc = ({ rt }: RuntimeHandle, bytes: number): number => {
  const ptr = rt._malloc(Math.max(bytes, 1));
  if (ptr === 0) throw new RuntimeRefused(`malloc(${bytes}) failed`);
  return ptr;
};

// Copies data into the runtime's heap for the length of use().
export const withBytes = <T>(handle: RuntimeHandle, data: Uint8Array, use: (ptr: number) => T): T => {
  const ptr = alloc(handle, data.length);
  handle.bytes.set(data, ptr);
  let intact = true;
  try {
    return use(ptr);
  } catch (error) {
    intact = error instanceof RuntimeRefused;
    throw error;
  } finally {
    if (intact) handle.rt._free(ptr);
  }
};

export const withString = <T>(handle: RuntimeHandle, text: string, use: (ptr: number) => T): T =>
  withBytes(handle, encoder.encode(`${text}\0`), use);

// Writes each module through the runtime's own libc, so it lands in its file
// system whatever backs it, then loads it.
export const loadSides = (handle: RuntimeHandle, sides: readonly SideModule[]): void => {
  const { rt } = handle;
  const dir = "/sides";
  withString(handle, dir, (ptr) => rt._mkdir(ptr, 0o755));
  for (const { name, bytes } of sides) {
    const path = `${dir}/${name}.wasm`;
    const fd = withString(handle, path, (ptr) => rt._creat(ptr, 0o644));
    check(`creat ${path}`, fd);
    const data = new Uint8Array(bytes);
    const written = withBytes(handle, data, (ptr) => rt._write(fd, ptr, data.length));
    check(`close ${path}`, rt._close(fd));
    if (written !== data.length) throw new RuntimeRefused(`write ${path}: ${written} of ${data.length}`);
    check(
      `load ${name}`,
      withString(handle, path, (ptr) => rt._ibusweb_load_module(ptr, 0)),
    );
  }
};
