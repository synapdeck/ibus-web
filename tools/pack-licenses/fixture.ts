// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Throwaway repository trees for the tests.

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Spelled in pieces so REUSE doesn't take the fixtures' tags for this file's.
export const KEY = ["SPDX", "License", "Identifier"].join("-");

/** A header line declaring the repository's own license. */
export const own = (comment = "//") => `${comment} ${KEY}: MIT OR Apache-2.0\n`;

/** A version 3 sourcemap naming the given sources. */
export const sourceMap = (...sources: readonly string[]) => JSON.stringify({ version: 3, sources, mappings: "" });

const roots: string[] = [];

/** Writes the files, by path relative to a new temporary root, and returns the root. */
export async function makeTree(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pack-licenses-")));
  roots.push(root);

  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }

  return root;
}

export async function cleanUp(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}
