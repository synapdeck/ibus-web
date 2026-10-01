// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The spike's Worker host. Its one message is a HostInit: it instantiates the
// runtime, mounts storage, loads the side modules, sets the runtime up, then
// serves requests from the control buffer for good, sleeping between them
// with the next GLib deadline as the timeout. Only this Worker, and the
// relay it starts, touch the runtime's memory.

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
  _wasmfs_create_opfs_backend(): number;
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
  syncAccessHandle:
    typeof FileSystemFileHandle === "function" &&
    "createSyncAccessHandle" in FileSystemFileHandle.prototype,
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
  if (storage.kind === "memory") return;
  const { rt } = heap;
  // Its parents, in memory; one that exists already fails harmlessly.
  const parts = storage.mountPath.split("/").filter((part) => part !== "");
  for (let i = 1; i < parts.length; i++)
    heap.withString(`/${parts.slice(0, i).join("/")}`, (ptr) =>
      rt._mkdir(ptr, 0o755),
    );
  // The OPFS backend starts a thread of its own, from the pool, that runs
  // its asynchronous calls for good.
  const backend =
    storage.kind === "node"
      ? heap.withString(storage.hostPath, (ptr) =>
          rt._wasmfs_create_node_backend(ptr),
        )
      : rt._wasmfs_create_opfs_backend();
  if (backend === 0)
    throw new Error(`no ${storage.kind} backend for ${storage.mountPath}`);
  check(
    `mount ${storage.mountPath}`,
    heap.withString(storage.mountPath, (ptr) =>
      rt._wasmfs_create_directory(ptr, 0o777, backend),
    ),
  );
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

// A spike instrument: tracks the Workers Emscripten creates, through the
// global Worker class. Under Node, Emscripten first assigns worker_threads'
// Worker to the global, so the global becomes an accessor that wraps
// whichever class it is given. Emscripten marks the Worker hosting a thread
// with that thread's pointer, and clears it once the Worker is back in its
// pool.
interface Workers {
  // Created since counting started.
  created: number;
  counting: boolean;
  idle(): number;
}

const trackWorkers = (): Workers => {
  const all: Worker[] = [];
  const workers: Workers = {
    created: 0,
    counting: false,
    idle: () =>
      all.filter((worker) => !(worker as { pthread_ptr?: number }).pthread_ptr)
        .length,
  };
  const wrap = (Base: typeof Worker): typeof Worker =>
    class extends Base {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        all.push(this);
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
}

// Answers the request in the slot. Only HostOp.yield answers later, after
// the returned promise settles.
const serve = (
  heap: Heap,
  control: ControlViews,
  constants: BuildConstants,
  buffers: { request: number; reply: number; cap: number; mallinfo: number },
  workers: Workers,
  counters: Counters,
): Promise<void> | undefined => {
  const request = requestBytes(control);
  if (request.length >= 4) {
    switch (requestOpcode(request)) {
      case HostOp.stats: {
        const stats: HostStats = {
          workersCreated: workers.created,
          idleWorkers: workers.idle(),
          heapInUse: heapInUse(heap, constants, buffers.mallinfo),
          ...counters,
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

const start = async (init: HostInit<WebAssembly.Module>): Promise<void> => {
  const startedAt = performance.now();
  const control = controlViews(init.control);
  const { constants } = init;
  const { default: createRuntime } = (await import(init.runtimeUrl)) as {
    default: CreateRuntime;
  };
  const workers = trackWorkers();
  const { wasm } = init;
  // Emscripten has no way to hear that instantiateWasm failed, so a failure
  // ends the wait for the runtime here instead.
  let failInstantiate: (error: unknown) => void = () => {};
  const instantiateFailed = new Promise<never>((_, reject) => {
    failInstantiate = reject;
  });
  const rt = await Promise.race([
    createRuntime(
      wasm === undefined
        ? {}
        : {
            instantiateWasm: (imports, done) => {
              WebAssembly.instantiate(wasm, imports).then(
                (instance) => done(instance, wasm),
                failInstantiate,
              );
              return {};
            },
          },
    ),
    instantiateFailed,
  ]);
  workers.counting = true;
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
  const counters: Counters = { requests: 0, requestsWhileAsleep: 0 };
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
  try {
    for (;;) {
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
          counters,
        );
        if (later !== undefined) await later;
        continue;
      }
      woken = false;
      const delay = pump(rt, constants);
      const after = Atomics.load(control.words, Word.state);
      if (after === State.request || after === State.crashed) continue;
      const timeout = delay < 0 ? Infinity : delay;
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
