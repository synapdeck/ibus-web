// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The runtime, released and asserting alike, refuses to start without a
// memory from the host, loads side modules and dispatches their operations,
// takes the memories it should and no others, and never grows one.

import fs from "node:fs";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { nodeTestData as data } from "@ibus-web/test-programs/node-tests";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type CreateRuntime,
  type HarnessData,
  type Runtime,
  int32s,
  loadRuntime,
  readHarnessData,
  sharedMemory,
  startRuntime,
  utf8,
} from "./harness.ts";

// The lines the runtime prints, which under Node it writes to file
// descriptors 1 and 2 with fs.writeSync(): a test takes those it expects,
// and any other fails it.
const printed: string[] = [];
const writeSync = fs.writeSync;
vi.spyOn(fs, "writeSync").mockImplementation(((fd: unknown, data: unknown, ...rest: unknown[]): number => {
  if ((fd !== 1 && fd !== 2) || typeof data !== "string") return Reflect.apply(writeSync, fs, [fd, data, ...rest]);
  printed.push(...data.split("\n").filter((line) => line !== ""));
  return Buffer.byteLength(data);
}) as typeof fs.writeSync);

// Takes the printed lines matching pattern, failing unless there are count.
const takePrinted = (pattern: RegExp, count = 1): string[] => {
  const taken = printed.filter((line) => pattern.test(line));
  expect(taken, `printed lines matching ${pattern}`).toHaveLength(count);
  for (const line of taken) printed.splice(printed.indexOf(line), 1);
  return taken;
};

// Takes every printed line, which must be none: for what the hooks and
// anything between tests printed, as well as each test.
const nothingElse = (): void => {
  expect(printed.splice(0), "printed nothing else").toEqual([]);
};
beforeEach(nothingElse);
afterEach(nothingElse);
afterAll(nothingElse);

let harness: HarnessData;

beforeAll(async () => {
  harness = await readHarnessData(data("harness"));
});

const errno = (name: string): number => {
  const value = harness.errno[name];
  if (value === undefined) throw new Error(`no ${name} in Emscripten's errno.h`);
  return value;
};

const text = (reply: Uint8Array | number): string =>
  typeof reply === "number" ? `errno ${reply}` : new TextDecoder().decode(reply);

const MiB = 2 ** 20;

describe.each([
  { build: "released", runtime: data("released"), asserting: false },
  { build: "asserting", runtime: data("asserting"), asserting: true },
])("the $build runtime", ({ runtime, asserting }) => {
  let createRuntime: CreateRuntime;
  let rt: Runtime;
  // Each side module the runtime loaded, by its key in the test data: what
  // ibusweb_load_module() returned, and the instances the runtime's loader
  // made, with the imports it gave each.
  const sides = ["side", "cxxSide", "throwSide", "hangulSide"] as const;
  const loaded = new Map<
    (typeof sides)[number],
    { result: number; instances: { module: WebAssembly.Module; imports: WebAssembly.Imports }[] }
  >();
  const loadedSide = (key: (typeof sides)[number]) => loaded.get(key)!;

  beforeAll(async () => {
    createRuntime = await loadRuntime(runtime);
    rt = await startRuntime(createRuntime, harness);
    // The runtime's loader hands a side module, for each import, the
    // function the runtime provides under that name, or a stub that looks
    // the name up on the first call and fails then if nothing provides it.
    // Recording what the module was given tells them apart without calling
    // anything.
    const Instance = WebAssembly.Instance;
    let instances: { module: WebAssembly.Module; imports: WebAssembly.Imports }[] = [];
    WebAssembly.Instance = class extends Instance {
      constructor(module: WebAssembly.Module, imports: WebAssembly.Imports) {
        super(module, imports);
        instances.push({ module, imports });
      }
    };
    try {
      for (const key of sides) {
        instances = [];
        const path = `/tmp/${key}.wasm`;
        rt.writeFile(path, await readFile(data(key)));
        loaded.set(key, { result: rt.loadModule(path), instances });
      }
    } finally {
      WebAssembly.Instance = Instance;
    }
  });

  // Without one, the runtime would make a memory of its least size.
  test("refuses to start without a memory from the host", async () => {
    await expect(createRuntime()).rejects.toThrow(/must pass wasmMemory/);
  });

  test("loads a side module", () => {
    expect(loadedSide("side").result).toBe(0);
    expect(loadedSide("side").instances).toHaveLength(1);
    // Nothing is due.
    expect(rt.pump()).toBe(-1);
  });

  test("dispatches to a side module's operation", () => {
    expect(text(rt.dispatch(1, utf8("ibus-web")))).toBe("bew-subi");
  });

  test("replies ENOSYS to an opcode no module registers", () => {
    expect(rt.dispatch(2)).toBe(-errno("ENOSYS"));
  });

  // assert(), EM_ASM and emscripten_get_now() are JavaScript in the runtime,
  // which it provides to side modules because its export list names them;
  // so are the other names on the list that its wasm doesn't export.
  test("provides side modules the JavaScript functions its export list names", async () => {
    const [{ module, imports }] = loadedSide("side").instances as [ReturnType<typeof loadedSide>["instances"][number]];
    const env = imports["env"]!;
    for (const name of ["__assert_fail", "emscripten_asm_const_int", "emscripten_get_now"]) {
      expect(WebAssembly.Module.imports(module)).toContainEqual({ module: "env", name, kind: "function" });
      expect(env[name], name).toBe(rt.module[`_${name}`]);
    }
    const runtimeUrl = pathToFileURL(runtime);
    const wasm = await WebAssembly.compile(await readFile(new URL("ibus-runtime.wasm", runtimeUrl)));
    const exported = new Set(WebAssembly.Module.exports(wasm).map((e) => e.name));
    const { libraries } = JSON.parse(await readFile(new URL("exports.json", runtimeUrl), "utf8")) as {
      libraries: { symbols: string[] }[];
    };
    const javascript = libraries.flatMap((l) => l.symbols).filter((name) => !exported.has(name));
    expect(javascript).not.toHaveLength(0);
    for (const name of javascript) expect(typeof rt.module[`_${name}`], name).toBe("function");
  });

  test("runs a side module's calls into JavaScript", () => {
    const reply = rt.dispatch(4, int32s(21));
    if (typeof reply === "number") throw new Error(`errno ${reply}`);
    expect(reply).toHaveLength(12);
    const view = new DataView(reply.buffer);
    expect(view.getInt32(0, true)).toBe(42);
    expect(view.getFloat64(4, true)).toBeGreaterThan(0);
  });

  test("loads a C++ side module on the runtime's libc++", () => {
    expect(loadedSide("cxxSide").result).toBe(0);
    expect(text(rt.dispatch(10, utf8("side")))).toBe("hello, side");
  });

  test("catches a C++ exception a side module's operation throws", () => {
    expect(loadedSide("throwSide").result).toBe(0);
    expect(rt.dispatch(11)).toBe(-errno("ECANCELED"));
    takePrinted(/ibus-web-WARNING.*Operation 11 threw: thrown in a side module/);
    // The runtime keeps serving.
    expect(text(rt.dispatch(1, utf8("ok")))).toBe("ko");
  });

  test("loads a side module with a static library linked in", () => {
    expect(loadedSide("hangulSide").result).toBe(0);
    const reply = rt.dispatch(12, utf8("gks"));
    if (typeof reply === "number") throw new Error(`errno ${reply}`);
    // 한, from ㅎ, ㅏ and ㄴ.
    expect([...new Uint32Array(reply.slice().buffer)]).toEqual([0xd55c]);
  });

  // _Exit() throws Emscripten's ExitStatus, a JavaScript exception; the
  // dispatcher turns only C++ ones into an error reply.
  test("lets _Exit()'s exception through to its caller", () => {
    const exitCode = process.exitCode;
    try {
      expect(() => rt.dispatch(3)).toThrow(expect.objectContaining({ name: "ExitStatus", status: 3 }));
    } finally {
      // Emscripten's _Exit() also sets the code Node exits with.
      process.exitCode = exitCode;
    }
    // The runtime keeps running, and the dispatcher held nothing when it
    // unwound.
    expect(text(rt.dispatch(1, utf8("ok")))).toBe("ko");
  });

  test("takes any memory from the least to the most, which its heap then spans", async () => {
    const bytes = harness.memory.minimum + 64 * MiB;
    const larger = await startRuntime(createRuntime, harness, { bytes });
    expect(larger.module._emscripten_get_heap_max()).toBe(bytes);
  });

  test.each([
    {
      memory: "smaller than the least",
      make: ({ minimum }: HarnessData["memory"]) => sharedMemory(minimum - 64 * 1024),
    },
    {
      memory: "with a maximum above the most",
      make: ({ minimum, maximum }: HarnessData["memory"]) => sharedMemory(minimum, 2 * maximum),
    },
  ])("refuses a memory $memory", async ({ make }) => {
    await expect(createRuntime({ wasmMemory: make(harness.memory), ibuswebEngineThreads: 0 })).rejects.toThrow(
      /LinkError/,
    );
    takePrinted(/^failed to asynchronously prepare wasm: LinkError/);
    takePrinted(/^warning: Loading from a file URI/, asserting ? 1 : 0);
    takePrinted(/^Aborted\(LinkError/);
  });

  describe("on a memory with room above its size", () => {
    let roomy: Runtime;
    beforeAll(async () => {
      roomy = await startRuntime(createRuntime, harness, { maximum: harness.memory.maximum });
    });

    test("never grows its memory", () => {
      expect(roomy.module._emscripten_get_heap_max()).toBe(harness.memory.minimum);
    });

    // Even for an allocation that is allowed to fail. The runtime is no use
    // after, so this comes last.
    test("aborts when its heap is full", () => {
      expect(() => roomy.module._g_try_malloc(harness.memory.minimum)).toThrow(WebAssembly.RuntimeError);
      takePrinted(/^Aborted\(.*OOM/);
      expect(roomy.wasmMemory.buffer.byteLength).toBe(harness.memory.minimum);
    });
  });
});

// The IndexedDB backend's JavaScript calls back into it through function
// pointers, so no export of the runtime is an internal of the backend that a
// side module could import.
test("released and asserting runtimes export none of the IndexedDB backend's internals", async () => {
  for (const runtime of [data("released"), data("asserting")]) {
    const wasm = await WebAssembly.compile(await readFile(new URL("ibus-runtime.wasm", pathToFileURL(runtime))));
    const names = WebAssembly.Module.exports(wasm).map(({ name }) => name);
    expect(names).toContain("wasmfs_create_idb_backend");
    expect(names.filter((name) => name.startsWith("_wasmfs_idb_"))).toEqual([]);
  }
});

test("released and asserting distributions ship the generated runtime constants", async () => {
  const expected = await readFile(data("constants"), "utf8");
  const constants = JSON.parse(expected) as Record<string, unknown>;
  expect(Object.keys(constants).sort()).toEqual([
    "canceled",
    "fs",
    "idbReadOnly",
    "memory",
    "poolLowWater",
    "protocol",
    "pumpError",
    "runtimeAbi",
    "runtimeIdentity",
    "waitTimedOut",
  ]);
  for (const runtime of [data("released"), data("asserting")])
    expect(await readFile(new URL("constants.json", pathToFileURL(runtime)), "utf8")).toBe(expected);
});
