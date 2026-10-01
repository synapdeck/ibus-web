// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The spike's Worker host. Its one message is a HostInit: it instantiates the
// runtime, mounts storage, loads the side modules, sets the runtime up, then
// serves requests from the control buffer for good, sleeping between them
// with the next GLib deadline as the timeout. Only this Worker, and the
// relay it starts, touch the runtime's memory.

import {
  controlViews,
  HostOp,
  postCrash,
  postReply,
  requestBytes,
  requestOpcode,
  State,
  Word,
  type ControlViews,
  type HostInit,
  type HostMessage,
  type HostStats,
  type SideModule,
  type Storage,
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
  _close(fd: number): number;
  _mkdir(path: number, mode: number): number;
  _wasmfs_create_node_backend(root: number): number;
  _wasmfs_create_directory(path: number, mode: number, backend: number): number;
  _ibusweb_runtime_init(wakeWord: number): number;
  _ibusweb_pump(): number;
  _ibusweb_wait(seen: number, timeoutMs: number): number;
  _ibusweb_load_module(path: number, moduleOut: number): number;
  _ibusweb_dispatch(
    request: number,
    requestLen: number,
    reply: number,
    replyCap: number,
  ): number;
  _mallinfo(out: number): void;
}

type InstantiateWasm = (
  imports: WebAssembly.Imports,
  done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
) => object;

type CreateRuntime = (settings: {
  instantiateWasm?: InstantiateWasm;
}) => Promise<Runtime>;

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

// IBUSWEB_PUMP_ERROR.
const PUMP_ERROR = -(2 ** 31);

const post = (message: HostMessage): void => self.postMessage(message);

const describe = (error: unknown): string =>
  error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
    : String(error);

const encoder = new TextEncoder();

class Heap {
  readonly rt: Runtime;
  readonly bytes: Uint8Array;
  readonly words: Int32Array;

  constructor(rt: Runtime) {
    this.rt = rt;
    // The runtime's memory never grows, so these views stay valid.
    this.bytes = rt.HEAPU8;
    this.words = new Int32Array(this.bytes.buffer);
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

const mount = (heap: Heap, storage: Storage): void => {
  switch (storage.kind) {
    case "memory":
      return;
    case "node": {
      const backend = heap.withString(storage.hostPath, (ptr) =>
        heap.rt._wasmfs_create_node_backend(ptr),
      );
      if (backend === 0)
        throw new Error(`no Node backend over ${storage.hostPath}`);
      check(
        `mount ${storage.mountPath}`,
        heap.withString(storage.mountPath, (ptr) =>
          heap.rt._wasmfs_create_directory(ptr, 0o777, backend),
        ),
      );
    }
  }
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

// Counts the Workers Emscripten creates once the runtime runs, which it does
// through the global Worker class whenever its pool is empty.
const countWorkers = (): { created: number } => {
  const counter = { created: 0 };
  const Base = globalThis.Worker;
  globalThis.Worker = class extends Base {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args);
      counter.created++;
    }
  };
  return counter;
};

// Long enough that the loop reaches the messages already queued for it, not
// only the timer.
const yieldToEventLoop = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// struct mallinfo: ten ints, uordblks (bytes in use) the eighth.
const MALLINFO_WORDS = 10;
const MALLINFO_IN_USE = 7;

const heapInUse = (heap: Heap, scratch: number): number => {
  heap.rt._mallinfo(scratch);
  return heap.words[scratch / 4 + MALLINFO_IN_USE]!;
};

const pump = (rt: Runtime): number => {
  const delay = rt._ibusweb_pump();
  if (delay === PUMP_ERROR) throw new Error("pumped off the runtime's thread");
  return delay;
};

// Answers the request in the slot. Only HostOp.yield answers later, after
// the returned promise settles.
const serve = (
  heap: Heap,
  control: ControlViews,
  buffers: { request: number; reply: number; cap: number; mallinfo: number },
  workers: { created: number },
): Promise<void> | undefined => {
  const request = requestBytes(control);
  if (request.length >= 4) {
    switch (requestOpcode(request)) {
      case HostOp.stats: {
        const stats: HostStats = {
          workersCreated: workers.created,
          heapInUse: heapInUse(heap, buffers.mallinfo),
        };
        const json = encoder.encode(JSON.stringify(stats));
        postReply(control, json.length, json);
        return undefined;
      }
      case HostOp.yield: {
        const ms =
          request.length >= 8
            ? new DataView(request.buffer, request.byteOffset + 4).getInt32(
                0,
                true,
              )
            : 10;
        return yieldToEventLoop(ms).then(() => postReply(control, 0));
      }
    }
  }
  heap.bytes.set(request, buffers.request);
  const ret = heap.rt._ibusweb_dispatch(
    buffers.request,
    request.length,
    buffers.reply,
    buffers.cap,
  );
  pump(heap.rt);
  postReply(
    control,
    ret,
    ret > 0
      ? heap.bytes.subarray(buffers.reply, buffers.reply + ret)
      : undefined,
  );
  return undefined;
};

const start = async (init: HostInit<WebAssembly.Module>): Promise<void> => {
  const startedAt = performance.now();
  const control = controlViews(init.control);
  const { default: createRuntime } = (await import(init.runtimeUrl)) as {
    default: CreateRuntime;
  };
  const { wasm } = init;
  const rt = await createRuntime(
    wasm === undefined
      ? {}
      : {
          instantiateWasm: (imports, done) => {
            void WebAssembly.instantiate(wasm, imports).then((instance) =>
              done(instance, wasm),
            );
            return {};
          },
        },
  );
  const workers = countWorkers();
  const heap = new Heap(rt);

  mount(heap, init.storage);
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
  const relay = await startRelay(
    init.wait === "control"
      ? { from: runtimeWord, to: controlWord }
      : { from: controlWord, to: runtimeWord },
  );

  const cap = control.slot.length;
  const buffers = {
    request: heap.alloc(cap),
    reply: heap.alloc(cap),
    cap,
    mallinfo: heap.alloc(MALLINFO_WORDS * 4),
  };
  post({ type: "ready", startupMs: performance.now() - startedAt });

  // Each word is read before the state and the pump look, so a wake that
  // lands after them changes it and the sleep returns at once.
  const [sleepWords, sleepIndex] =
    init.wait === "control"
      ? [control.words, Word.wake]
      : [heap.words, wakeIndex];
  try {
    for (;;) {
      const seen = Atomics.load(sleepWords, sleepIndex);
      if (Atomics.load(control.words, Word.state) === State.request) {
        const later = serve(heap, control, buffers, workers);
        if (later !== undefined) await later;
        continue;
      }
      const delay = pump(rt);
      if (Atomics.load(control.words, Word.state) === State.request) continue;
      const timeout = delay < 0 ? Infinity : delay;
      switch (init.wait) {
        case "runtime":
          rt._ibusweb_wait(seen, delay);
          break;
        case "runtime-async": {
          const result = waitAsync(heap.words, wakeIndex, seen, timeout);
          if (result.async) await result.value;
          break;
        }
        case "control":
          Atomics.wait(control.words, Word.wake, seen, timeout);
      }
    }
  } catch (error) {
    postCrash(control);
    relay.terminate();
    post({ type: "crashed", message: describe(error) });
  }
};

self.onmessage = ({ data }: MessageEvent<HostInit<WebAssembly.Module>>) => {
  self.onmessage = null;
  start(data).catch((error: unknown) =>
    post({ type: "error", message: describe(error) }),
  );
};
