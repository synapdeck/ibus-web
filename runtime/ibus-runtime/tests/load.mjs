// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node load.mjs RUNTIME_JS SIDE_WASM
// Checks the runtime refuses to start without a memory from the host, then
// loads a side module into it and dispatches its operations, then checks
// what memories it takes and that it never grows one.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { errno, int32s, memoryLimits, sharedMemory, startRuntime, utf8 } from "./harness.mjs";

const [runtime, side] = process.argv.slice(2);
const runtimeUrl = pathToFileURL(runtime);

// Without a memory from the host, the runtime would make one of its least
// size.
const { default: createRuntime } = await import(runtimeUrl.href);
await assert.rejects(async () => createRuntime(), /must pass wasmMemory/);

const rt = await startRuntime(runtime);

// The runtime's loader hands a side module, for each import, the function
// the runtime provides under that name, or a stub that looks the name up on
// the first call and fails then if nothing provides it. Recording what the
// module was given tells them apart without calling anything.
const instances = [];
WebAssembly.Instance = class extends WebAssembly.Instance {
  constructor(module, imports) {
    super(module, imports);
    instances.push({ module, imports });
  }
};

rt.writeFile("/tmp/side.wasm", await readFile(side));
assert.equal(rt.loadModule("/tmp/side.wasm"), 0, "ibusweb_load_module");
assert.equal(rt.pump(), -1);

const reversed = rt.dispatch(1, utf8("ibus-web"));
assert.equal(new TextDecoder().decode(reversed), "bew-subi");
assert.equal(rt.dispatch(2), -errno.ENOSYS);
console.log("reverse ok");

// assert(), EM_ASM and emscripten_get_now() are JavaScript in the runtime,
// which it provides to side modules because its export list names them.
assert.equal(instances.length, 1);
const [{ module, imports }] = instances;
for (const name of ["__assert_fail", "emscripten_asm_const_int", "emscripten_get_now"]) {
  assert.ok(
    WebAssembly.Module.imports(module).some((i) => i.module === "env" && i.name === name),
    `the side module imports ${name}`,
  );
  assert.equal(imports.env[name], rt.module[`_${name}`], `the runtime provides ${name}`);
}
// The listed names the runtime's wasm doesn't export are JavaScript, which
// the runtime provides alike.
const wasm = await WebAssembly.compile(await readFile(new URL("ibus-runtime.wasm", runtimeUrl)));
const exported = new Set(WebAssembly.Module.exports(wasm).map((e) => e.name));
const { libraries } = JSON.parse(await readFile(new URL("exports.json", runtimeUrl), "utf8"));
const javascript = libraries.flatMap((l) => l.symbols).filter((name) => !exported.has(name));
assert.ok(javascript.length > 0);
for (const name of javascript) {
  assert.equal(typeof rt.module[`_${name}`], "function", `the runtime provides ${name}`);
}
console.log(`${javascript.length} JavaScript functions provided`);

const reply = rt.dispatch(4, int32s(21));
assert.equal(reply.length, 12);
const view = new DataView(reply.buffer);
assert.equal(view.getInt32(0, true), 42);
assert.ok(view.getFloat64(4, true) > 0);
console.log("javascript ok");

// The dispatcher turns only C++ exceptions into an error reply; _Exit()'s
// is a JavaScript one and reaches the caller.
assert.throws(() => rt.dispatch(3), { name: "ExitStatus", status: 3 });
// Emscripten's _Exit() also sets the code Node exits with.
process.exitCode = 0;
// The runtime keeps running, and the dispatcher held nothing when it unwound.
assert.equal(new TextDecoder().decode(rt.dispatch(1, utf8("ok"))), "ko");
console.log("exit passes through");

// Any size from the least to the most, which the heap then spans; nothing
// outside them.
const { minimum, maximum } = memoryLimits;
const MiB = 2 ** 20;
const larger = await startRuntime(runtime, { bytes: minimum + 64 * MiB });
assert.equal(larger.module._emscripten_get_heap_max(), minimum + 64 * MiB);
for (const wasmMemory of [sharedMemory(minimum - 64 * 1024), sharedMemory(minimum, 2 * maximum)]) {
  await assert.rejects(async () => createRuntime({ wasmMemory }), /LinkError/);
}
console.log("memory sizes ok");

// A memory with room above its size still never grows: an allocation the
// heap can't hold, even one that is allowed to fail, aborts the runtime.
const roomy = await startRuntime(runtime, { maximum });
assert.equal(roomy.module._emscripten_get_heap_max(), minimum);
assert.throws(() => roomy.module._g_try_malloc(minimum), WebAssembly.RuntimeError);
assert.equal(roomy.wasmMemory.buffer.byteLength, minimum);
console.log("a full heap aborts");
// An aborted runtime leaves its pthreads' Workers running, which keep Node
// alive.
process.exit();
