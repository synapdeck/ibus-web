// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Drives ibus-runtime at the C level from Node: instantiates it, writes side
// modules into its file system, and calls its API directly. What it needs
// from the build (Emscripten's errno values, the runtime's memory limits,
// the header's constants) it reads from a directory of JSON files.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface HarnessData {
  // Emscripten numbers errno values its own way: its <errno.h>, by name.
  errno: Readonly<Record<string, number>>;
  // The least and the most memory the runtime takes, in bytes; the least
  // is enough for the runtime alone.
  memory: { minimum: number; maximum: number };
  // What ibusweb_pump() returns when called off the thread that owns the
  // runtime.
  pumpError: number;
}

const readJson = async (dir: string, name: string): Promise<unknown> =>
  JSON.parse(await readFile(join(dir, name), "utf8"));

export const readHarnessData = async (dir: string): Promise<HarnessData> => {
  const errno = (await readJson(dir, "errno.json")) as Record<string, number>;
  const memory = (await readJson(dir, "memory.json")) as HarnessData["memory"];
  const { pumpError } = (await readJson(dir, "constants.json")) as { pumpError: number };
  return { errno, memory, pumpError };
};

// The part of the runtime's Emscripten module the harness and its callers
// use; every other export is there too, under its C name with a leading
// underscore.
export interface RuntimeModule {
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _creat(path: number, mode: number): number;
  _write(fd: number, ptr: number, bytes: number): number;
  _close(fd: number): number;
  _ibusweb_runtime_init(wake: number): number;
  _ibusweb_load_module(path: number, flags: number): number;
  _ibusweb_test_dispatch(request: number, length: number, reply: number, capacity: number): number;
  _ibusweb_pump(): number;
  _emscripten_get_heap_max(): number;
  _g_try_malloc(bytes: number): number;
  [name: `_${string}`]: unknown;
}

export type CreateRuntime = (options?: { wasmMemory?: WebAssembly.Memory }) => Promise<RuntimeModule>;

// The runtime's module factory.
export const loadRuntime = async (path: string): Promise<CreateRuntime> =>
  ((await import(/* @vite-ignore */ pathToFileURL(path).href)) as { default: CreateRuntime }).default;

// The capacity of the buffer replies are read into; the runtime reports
// -ENOBUFS beyond it.
const REPLY_CAP = 4096;

const PAGE = 65536;

export const int32s = (...values: number[]): Uint8Array => new Uint8Array(new Int32Array(values).buffer);

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export const sharedMemory = (bytes: number, maximum = bytes): WebAssembly.Memory =>
  new WebAssembly.Memory({ initial: bytes / PAGE, maximum: maximum / PAGE, shared: true });

const check: (condition: boolean, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`harness: ${message}`);
};

export interface Runtime {
  module: RuntimeModule;
  wasmMemory: WebAssembly.Memory;
  // The reply's bytes, or the negative errno ibusweb_test_dispatch() returned.
  dispatch(opcode: number, payload?: Uint8Array): Uint8Array | number;
  // An operation whose reply is one int32, or the negative errno.
  call(opcode: number, payload?: Uint8Array): number;
  pump(): number;
  // Pumps, sleeping on the wake word as a host would, until result()
  // returns something other than -EAGAIN, and returns that.
  settle(result: () => number, timeoutMs?: number): Promise<number>;
  // Writes through the runtime's own libc, so the file lands in its file
  // system whatever backs it.
  writeFile(path: string, bytes: Uint8Array): void;
  loadModule(path: string): number;
}

// Starts the runtime on a memory of bytes, whose maximum can be set apart.
export const startRuntime = async (
  createRuntime: CreateRuntime,
  data: HarnessData,
  { bytes = data.memory.minimum, maximum = bytes }: { bytes?: number; maximum?: number } = {},
): Promise<Runtime> => {
  const { errno, pumpError } = data;
  const wasmMemory = sharedMemory(bytes, maximum);
  const rt = await createRuntime({ wasmMemory });
  // The runtime never grows its memory, so views over it stay valid.
  const memory = rt.HEAPU8;
  const words = new Int32Array(memory.buffer);

  const alloc = (bytes: Uint8Array): number => {
    const ptr = rt._malloc(Math.max(bytes.length, 1));
    check(ptr !== 0, "malloc failed");
    memory.set(bytes, ptr);
    return ptr;
  };
  const withBytes = <T>(bytes: Uint8Array, use: (ptr: number) => T): T => {
    const ptr = alloc(bytes);
    try {
      return use(ptr);
    } finally {
      rt._free(ptr);
    }
  };
  const withString = <T>(text: string, use: (ptr: number) => T): T => withBytes(utf8(`${text}\0`), use);

  const wake = rt._malloc(4);
  const wakeIndex = wake / 4;
  Atomics.store(words, wakeIndex, 0);
  check(rt._ibusweb_runtime_init(wake) === 0, "ibusweb_runtime_init failed");

  const reply = rt._malloc(REPLY_CAP);

  const dispatch = (opcode: number, payload: Uint8Array = new Uint8Array()): Uint8Array | number => {
    const request = new Uint8Array(4 + payload.length);
    new DataView(request.buffer).setUint32(0, opcode, true);
    request.set(payload, 4);
    const ret = withBytes(request, (ptr) => rt._ibusweb_test_dispatch(ptr, request.length, reply, REPLY_CAP));
    return ret < 0 ? ret : memory.slice(reply, reply + ret);
  };

  const call = (opcode: number, payload?: Uint8Array): number => {
    const out = dispatch(opcode, payload);
    if (typeof out === "number") return out;
    check(out.length === 4, `opcode ${opcode}: reply of ${out.length} bytes`);
    return new DataView(out.buffer).getInt32(0, true);
  };

  const pump = (): number => {
    const delay = rt._ibusweb_pump();
    check(delay !== pumpError, "pumped off the owning thread");
    return delay;
  };

  // A wait that runs out while no source was due means a wake was lost.
  const settle = async (result: () => number, timeoutMs = 10_000): Promise<number> => {
    const deadline = performance.now() + timeoutMs;
    // A pending Atomics.waitAsync() doesn't keep Node's event loop alive.
    const keepAlive = setInterval(() => {}, timeoutMs);
    try {
      for (;;) {
        const seen = Atomics.load(words, wakeIndex);
        const delay = pump();
        const value = result();
        if (value !== -errno["EAGAIN"]!) return value;
        const left = deadline - performance.now();
        check(left > 0, "still pending at the deadline");
        const timeout = delay === -1 ? left : Math.min(delay, left);
        const { value: outcome } = Atomics.waitAsync(words, wakeIndex, seen, timeout);
        check(!((await outcome) === "timed-out" && delay === -1), "no wake while nothing was due");
      }
    } finally {
      clearInterval(keepAlive);
    }
  };

  const writeFile = (path: string, bytes: Uint8Array): void => {
    const fd = withString(path, (ptr) => rt._creat(ptr, 0o644));
    check(fd >= 0, `creat(${path}) failed`);
    const written = withBytes(bytes, (ptr) => rt._write(fd, ptr, bytes.length));
    check(written === bytes.length, `write(${path}) wrote ${written} of ${bytes.length} bytes`);
    check(rt._close(fd) === 0, `close(${path}) failed`);
  };

  const loadModule = (path: string): number => withString(path, (ptr) => rt._ibusweb_load_module(ptr, 0));

  return { module: rt, wasmMemory, dispatch, call, pump, settle, writeFile, loadModule };
};
