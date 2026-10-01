// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node load.mjs RUNTIME_JS SIDE_WASM
// Loads a side module into the runtime and dispatches its operations.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { errno, startRuntime, utf8 } from "./harness.mjs";

const [runtime, side] = process.argv.slice(2);
const rt = await startRuntime(runtime);

rt.writeFile("/tmp/side.wasm", await readFile(side));
assert.equal(rt.loadModule("/tmp/side.wasm"), 0, "ibusweb_load_module");
assert.equal(rt.pump(), -1);

const reversed = rt.dispatch(1, utf8("ibus-web"));
assert.equal(new TextDecoder().decode(reversed), "bew-subi");
assert.equal(rt.dispatch(2), -errno.ENOSYS);
console.log("reverse ok");

// The dispatcher turns only C++ exceptions into an error reply; _Exit()'s
// is a JavaScript one and reaches the caller.
assert.throws(() => rt.dispatch(3), { name: "ExitStatus", status: 3 });
// Emscripten's _Exit() also sets the code Node exits with.
process.exitCode = 0;
// The runtime keeps running, and the dispatcher held nothing when it unwound.
assert.equal(new TextDecoder().decode(rt.dispatch(1, utf8("ok"))), "ko");
console.log("exit passes through");
