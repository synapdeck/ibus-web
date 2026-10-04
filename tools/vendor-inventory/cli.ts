// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { parseArgs } from "node:util";
import { checkInventory } from "./inventory.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    readme: { type: "string" },
    upstream: { type: "string" },
    version: { type: "string" },
    hash: { type: "string" },
  },
});
const { root, readme, upstream, version, hash } = values;
if (!root || !readme || !upstream || !version || !hash) {
  throw new Error("usage: cli.ts --root DIR --readme README --upstream IBUS_SOURCE --version X.Y.Z --hash SRI");
}
const errors = await checkInventory({ root, readme, upstream, version, hash });
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Vendor inventory: every file accounted for against IBus ${version}`);
