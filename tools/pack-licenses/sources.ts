// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What a package's tarball bundles, from the sourcemaps beside its scripts.
// A source that is itself a built script with a map is followed through that
// map, so a bundle of another workspace package's dist/ leads back to that
// package's sources rather than stopping at its build output.

import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageManifest {
  readonly name: string;
  readonly files?: readonly string[];
  readonly ibusWeb?: {
    /** Packed directories copied from another package's build, to where they were built. */
    readonly copiedFrom?: Readonly<Record<string, string>>;
  };
}

export interface Bundled {
  readonly sources: ReadonlySet<string>;
  readonly problems: readonly string[];
}

interface SourceMap {
  readonly sources: readonly (string | null)[];
  readonly sourceRoot?: string;
}

const SCRIPT = /\.[cm]?js$/;

// Sources a bundler makes up rather than reads, such as its runtime helpers.
const isVirtual = (source: string) =>
  source.startsWith("\0") || (/^[a-z][a-z0-9+.-]*:/i.test(source) && !source.startsWith("file:"));

const inNodeModules = (path: string) => path.split(sep).includes("node_modules");

// A bundler writes no sourcemap for an entry that only re-exports other
// modules, since it has no code of its own to map. Whatever it imports from
// this package is a packed script with its own map, and anything else isn't
// bundled at all. The pattern admits only those statements, whitespace and
// semicolons: anything else is code, which would need a map.
const NAME = String.raw`[\w$]+`;
const BINDINGS = String.raw`\*(?:\s+as\s+${NAME})?|\{[^}]*\}|${NAME}(?:\s*,\s*(?:\*\s+as\s+${NAME}|\{[^}]*\}))?`;

const STATEMENT = new RegExp(
  String.raw`[\s;]*(?:(?:import|export)\b\s*(?:${BINDINGS})\s*from\s*"[^"]*"|import\s*"[^"]*"|export\s*\{[^}]*\})\s*;`,
  "y",
);

function onlyReexports(script: string): boolean {
  let end = 0;
  STATEMENT.lastIndex = 0;

  // A failed sticky match resets lastIndex, so the end of the last match is kept apart.
  while (STATEMENT.test(script)) end = STATEMENT.lastIndex;

  return end > 0 && script.slice(end).trim() === "";
}

async function walk(path: string): Promise<string[]> {
  if (!(await stat(path)).isDirectory()) return [path];

  const entries = await readdir(path);
  return (await Promise.all(entries.map((entry) => walk(join(path, entry))))).flat();
}

async function packedFiles(packageDir: string, manifest: PackageManifest): Promise<string[]> {
  const files: string[] = [];

  for (const entry of manifest.files ?? []) {
    if (/[*?[\]{}!]/.test(entry)) {
      throw new Error(`${manifest.name}: files entry ${entry} is a pattern, which pack-licenses doesn't expand`);
    }

    const path = join(packageDir, entry);
    // LICENSES and the like exist only while the package is being packed.
    if (existsSync(path)) files.push(...(await walk(path)));
  }

  return files;
}

// Where a packed file was built: a copied directory's sourcemaps are
// relative to the directory they were written in.
function builtAt(packageDir: string, manifest: PackageManifest, file: string): string {
  const packed = relative(packageDir, file).split(sep).join("/");

  for (const [copy, origin] of Object.entries(manifest.ibusWeb?.copiedFrom ?? {})) {
    if (packed.startsWith(`${copy}/`)) return resolve(packageDir, origin, packed.slice(copy.length + 1));
  }

  return file;
}

/** Every original file the package's packed scripts were built from, as real absolute paths. */
export async function bundledSources(packageDir: string, manifest: PackageManifest): Promise<Bundled> {
  const sources = new Set<string>();
  const problems: string[] = [];
  const followed = new Set<string>();

  const follow = async (mapPath: string): Promise<void> => {
    if (followed.has(mapPath)) return;
    followed.add(mapPath);

    const map = JSON.parse(await readFile(mapPath, "utf8")) as SourceMap;
    const base = resolve(dirname(mapPath), map.sourceRoot ?? "");

    for (const source of map.sources) {
      if (source === null || isVirtual(source)) continue;
      const path = source.startsWith("file:") ? fileURLToPath(source) : resolve(base, source);
      const real = existsSync(path) ? await realpath(path) : path;

      if (SCRIPT.test(real) && !inNodeModules(real) && existsSync(`${real}.map`)) await follow(`${real}.map`);
      else sources.add(real);
    }
  };

  for (const file of await packedFiles(packageDir, manifest)) {
    if (!SCRIPT.test(file)) continue;

    const map = `${builtAt(packageDir, manifest, file)}.map`;
    if (existsSync(map)) await follow(map);
    else if (onlyReexports(await readFile(file, "utf8"))) continue;
    else problems.push(`${relative(packageDir, file).split(sep).join("/")} has no sourcemap`);
  }

  return { sources, problems };
}
