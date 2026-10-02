// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Fails unless the package each given package directory resolves is the
// expected version: for dependencies whose version is fixed by something
// pnpm can't see, such as the nixpkgs build they work with.
//
//   assert-dependency.ts <package> <version> <why> <package directory>...

import { createRequire } from "node:module";
import path from "node:path";

const [name, expected, why, ...dirs] = process.argv.slice(2);
if (name === undefined || expected === undefined || why === undefined) {
  console.error("usage: assert-dependency.ts <package> <version> <why> <package directory>...");
  process.exit(1);
}

let failed = false;
for (const dir of dirs) {
  // Resolved as the package's own code would resolve it.
  const require = createRequire(path.resolve(dir, "package.json"));
  const { version } = require(`${name}/package.json`) as { version: string };
  if (version !== expected) {
    console.error(
      `${dir}: ${name} resolves to ${version}, but ${why} ${expected}; pin ${name} to exactly that version`,
    );
    failed = true;
  }
}
if (failed) process.exit(1);
