// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Fails unless the playwright package each given package directory resolves
// is the expected version.
//
//   assert-playwright.ts <version> <package directory>...

import { createRequire } from "node:module";
import path from "node:path";

const [expected, ...dirs] = process.argv.slice(2);
if (expected === undefined) {
  console.error("usage: assert-playwright.ts <version> <package directory>...");
  process.exit(1);
}

let failed = false;
for (const dir of dirs) {
  // Resolved as the package's own code would resolve it.
  const require = createRequire(path.resolve(dir, "package.json"));
  const { version } = require("playwright/package.json") as { version: string };
  if (version !== expected) {
    console.error(
      `${dir}: playwright resolves to ${version}, but its browsers come from ` +
        `nixpkgs' playwright-driver ${expected}; pin playwright to exactly that version`,
    );
    failed = true;
  }
}
if (failed) process.exit(1);
