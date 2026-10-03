// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const [root, readme] = process.argv.slice(2);
if (root === undefined || readme === undefined) {
  throw new Error("usage: vendor-inventory.ts ROOT README");
}

const actual = new Set<string>();
for (const directory of ["src/ibus", "include/ibus-1.0"]) {
  const entries = await readdir(join(root, directory), { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) actual.add(relative(root, join(entry.parentPath, entry.name)));
  }
}

// Inventory rows have a code-formatted relative path in the first column.
const listed = new Set<string>();
for (const line of (await readFile(readme, "utf8")).split("\n")) {
  if (!line.startsWith("|")) continue;
  const cell = line.split("|")[1]?.trim();
  if (cell === undefined || !cell.startsWith("`") || !cell.endsWith("`")) continue;
  const path = cell.slice(1, -1);
  if (listed.has(path)) throw new Error(`duplicate inventory entry: ${path}`);
  listed.add(path);
}

const missing = Array.from(actual)
  .filter((path) => !listed.has(path))
  .sort();
const stale = Array.from(listed)
  .filter((path) => !actual.has(path))
  .sort();
if (missing.length > 0 || stale.length > 0) {
  throw new Error(`inventory mismatch\nmissing: ${missing.join(", ")}\nstale: ${stale.join(", ")}`);
}
console.log(`Vendor inventory: ${actual.size} files accounted for`);
