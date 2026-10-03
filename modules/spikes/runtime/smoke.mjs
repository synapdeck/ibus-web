// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node smoke.mjs RUNTIME_JS SIDES_DIR CONSTANTS_JSON
// Loads each spike side module into the runtime and calls each of its
// operations through ibusweb_dispatch(), checking the replies.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { int32s, loadRuntime, readHarnessData, startRuntime, utf8 } from "./harness.ts";

const [runtime, sides, constants] = process.argv.slice(2);
// The opcodes the side modules register, as the build printed them.
const { ADD, IDLE_LATER, IDLE_RESULT, SPAWN, SPAWN_RESULT, THROW, FSYNC, FSYNC_RESULT } = JSON.parse(
  await readFile(constants, "utf8"),
).ops;
const harness = await readHarnessData(dirname(fileURLToPath(import.meta.url)));
const { errno } = harness;
const rt = await startRuntime(await loadRuntime(runtime), harness);

for (const name of ["trivial", "thread", "throw", "fsync"]) {
  const path = `/tmp/${name}.wasm`;
  rt.writeFile(path, await readFile(join(sides, `${name}.wasm`)));
  assert.equal(rt.loadModule(path), 0, `load ${name}`);
}

const check = (label, actual, expected) => {
  assert.equal(actual, expected, label);
  console.log(`${label}: ${actual}`);
};

check("add 2 40", rt.call(ADD, int32s(2, 40)), 42);
check("add -5 3", rt.call(ADD, int32s(-5, 3)), -2);

check("idle-result before", rt.call(IDLE_RESULT), -errno.ENOENT);
check("idle-later 50", rt.call(IDLE_LATER, int32s(50)), 0);
check("idle-later again", rt.call(IDLE_LATER, int32s(50)), -errno.EBUSY);
const delay = await rt.settle(() => rt.call(IDLE_RESULT));
assert.ok(delay >= 0, `idle-result ${delay}`);
console.log(`idle-result: attach to dispatch in ${delay} us`);

// Fewer threads than the pool holds: threads that earlier operations started
// may not be back in it yet.
// spawn-result replies how many threads were joined, then the error that
// stopped the rest.
const spawnResult = () => {
  const out = rt.dispatch(SPAWN_RESULT);
  return typeof out === "number" ? [out] : [...new Int32Array(out.buffer, out.byteOffset, out.length / 4)];
};
check("spawn 2", rt.call(SPAWN, int32s(2)), 0);
await rt.settle(() => spawnResult()[0]);
check("spawn-result", spawnResult().join(" "), "2 0");

check("throw", rt.call(THROW), -errno.ECANCELED);
check("add after throw", rt.call(ADD, int32s(1, 1)), 2);

// The writer writes the file's own path into it.
const file = "/tmp/fsync-spike.txt";
check("fsync", rt.call(FSYNC, utf8(file)), 0);
check("fsync-result", await rt.settle(() => rt.call(FSYNC_RESULT)), utf8(file).length);

check("unknown opcode", rt.call(99), -errno.ENOSYS);
