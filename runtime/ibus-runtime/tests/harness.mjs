// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Drives ibus-runtime at the C level from Node, for checks: instantiates it,
// writes side modules into its file system, and calls its API directly.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Emscripten numbers errno values its own way; errno.json holds its <errno.h>.
export const errno = JSON.parse(await readFile(new URL("errno.json", import.meta.url), "utf8"));

const { pumpError: PUMP_ERROR } = JSON.parse(await readFile(new URL("constants.json", import.meta.url), "utf8"));

// The capacity of the buffer replies are read into; the runtime reports
// -ENOBUFS beyond it.
const REPLY_CAP = 4096;

export const int32s = (...values) => new Uint8Array(new Int32Array(values).buffer);

export const utf8 = (text) => new TextEncoder().encode(text);

// The least and the most memory the runtime takes; the least is enough for
// the checks.
export const memoryLimits = JSON.parse(await readFile(new URL("memory.json", import.meta.url), "utf8"));

export const sharedMemory = (bytes, maximum = bytes) =>
  new WebAssembly.Memory({
    initial: bytes / 65536,
    maximum: maximum / 65536,
    shared: true,
  });

// Starts the runtime on a memory of bytes, whose maximum can be set apart.
export async function startRuntime(path, { bytes = memoryLimits.minimum, maximum = bytes } = {}) {
  const { default: createRuntime } = await import(pathToFileURL(path).href);
  const wasmMemory = sharedMemory(bytes, maximum);
  const rt = await createRuntime({ wasmMemory });
  // The runtime never grows its memory, so views over it stay valid.
  const memory = rt.HEAPU8;
  const words = new Int32Array(memory.buffer);

  const alloc = (bytes) => {
    const ptr = rt._malloc(Math.max(bytes.length, 1));
    assert.notEqual(ptr, 0, "malloc failed");
    memory.set(bytes, ptr);
    return ptr;
  };
  const withBytes = (bytes, use) => {
    const ptr = alloc(bytes);
    try {
      return use(ptr);
    } finally {
      rt._free(ptr);
    }
  };
  const withString = (text, use) => withBytes(utf8(`${text}\0`), use);

  const wake = rt._malloc(4);
  const wakeIndex = wake / 4;
  Atomics.store(words, wakeIndex, 0);
  assert.equal(rt._ibusweb_runtime_init(wake), 0, "ibusweb_runtime_init");

  const reply = rt._malloc(REPLY_CAP);

  // Returns the reply's bytes, or the negative errno ibusweb_dispatch()
  // returned.
  const dispatch = (opcode, payload = new Uint8Array()) => {
    const request = new Uint8Array(4 + payload.length);
    new DataView(request.buffer).setUint32(0, opcode, true);
    request.set(payload, 4);
    const ret = withBytes(request, (ptr) => rt._ibusweb_dispatch(ptr, request.length, reply, REPLY_CAP));
    return ret < 0 ? ret : memory.slice(reply, reply + ret);
  };

  // An operation whose reply is one int32.
  const call = (opcode, payload) => {
    const out = dispatch(opcode, payload);
    if (typeof out === "number") return out;
    assert.equal(out.length, 4, `opcode ${opcode}: reply of ${out.length} bytes`);
    return new DataView(out.buffer).getInt32(0, true);
  };

  const pump = () => {
    const delay = rt._ibusweb_pump();
    assert.notEqual(delay, PUMP_ERROR, "pumped off the owning thread");
    return delay;
  };

  // Pumps, sleeping on the wake word as a host would, until result()
  // returns something other than -EAGAIN. A wait that runs out while no
  // source was due means a wake was lost.
  const settle = async (result, timeoutMs = 10_000) => {
    const deadline = performance.now() + timeoutMs;
    // A pending Atomics.waitAsync() doesn't keep Node's event loop alive.
    const keepAlive = setInterval(() => {}, timeoutMs);
    try {
      for (;;) {
        const seen = Atomics.load(words, wakeIndex);
        const delay = pump();
        const value = result();
        if (value !== -errno.EAGAIN) return value;
        const left = deadline - performance.now();
        assert.ok(left > 0, "still pending at the deadline");
        const timeout = delay === -1 ? left : Math.min(delay, left);
        const { value: outcome } = Atomics.waitAsync(words, wakeIndex, seen, timeout);
        assert.ok(!((await outcome) === "timed-out" && delay === -1), "no wake while nothing was due");
      }
    } finally {
      clearInterval(keepAlive);
    }
  };

  // Writes through the runtime's own libc, so the file lands in its file
  // system whatever backs it.
  const writeFile = (path, bytes) => {
    const fd = withString(path, (ptr) => rt._creat(ptr, 0o644));
    assert.ok(fd >= 0, `creat(${path}) failed`);
    const written = withBytes(bytes, (ptr) => rt._write(fd, ptr, bytes.length));
    assert.equal(written, bytes.length, `write(${path})`);
    assert.equal(rt._close(fd), 0, `close(${path})`);
  };

  const loadModule = (path) => withString(path, (ptr) => rt._ibusweb_load_module(ptr, 0));

  return {
    module: rt,
    wasmMemory,
    dispatch,
    call,
    pump,
    settle,
    writeFile,
    loadModule,
  };
}
