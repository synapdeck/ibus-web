// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node load.mjs RUNTIME_JS SIDE_WASM
// Loads a side module into the runtime and dispatches its operation.

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
