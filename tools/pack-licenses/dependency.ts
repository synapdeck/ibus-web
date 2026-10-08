// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { readdir } from "node:fs/promises";
import { sep } from "node:path";

export interface Dependency {
  readonly name: string;
  readonly dir: string;
}

/** The npm package a file belongs to, by the last node_modules in its path. */
export function dependencyOf(file: string): Dependency | undefined {
  const parts = file.split(sep);
  const at = parts.lastIndexOf("node_modules");
  if (at === -1) return undefined;

  const end = at + (parts[at + 1]?.startsWith("@") ? 3 : 2);
  return { name: parts.slice(at + 1, end).join("/"), dir: parts.slice(0, end).join(sep) };
}

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-._].*)?$/i;

/** The license and notice files at the top of a package's directory. */
export async function licenseFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => LICENSE_FILE.test(name)).sort();
}
