// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { dependencyOf, licenseFiles } from "./dependency.ts";
import { NOTICES } from "./notices.ts";
import { licenseOf, parseReuseToml } from "./reuse.ts";
import { bundledSources, type PackageManifest } from "./sources.ts";
import { licenseIds } from "./spdx.ts";

export interface Copy {
  readonly from: string;
  readonly to: string;
}

export interface Plan {
  readonly copies: readonly Copy[];
  readonly problems: readonly string[];
}

// The repository's own license, which LICENSE-MIT and LICENSE-APACHE carry.
const OWN = "MIT OR Apache-2.0";

// Code-unit order, so the result doesn't depend on the locale.
const byDestination = (a: Copy, b: Copy) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0);

/** What a package's tarball needs copied in, by path in the package, and what it can't account for. */
export async function planLicenses(
  root: string,
  packageDir: string,
  notices: Readonly<Record<string, readonly string[]>> = NOTICES,
): Promise<Plan> {
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as PackageManifest;
  const annotations = parseReuseToml(await readFile(join(root, "REUSE.toml"), "utf8"));
  const bundled = await bundledSources(packageDir, manifest);

  const problems = new Set(bundled.problems);
  const copies = new Map<string, string>([
    ["LICENSE-MIT", join(root, "LICENSE-MIT")],
    ["LICENSE-APACHE", join(root, "LICENSE-APACHE")],
  ]);

  for (const [source, files] of Object.entries(notices)) {
    for (const path of [source, ...files]) {
      if (!existsSync(join(root, path))) problems.add(`notice map names ${path}, which doesn't exist`);
    }
  }

  // Two sources for one destination are fine only if they say the same thing.
  const add = async (to: string, from: string): Promise<void> => {
    const existing = copies.get(to);

    if (existing !== undefined && existing !== from) {
      const same = Buffer.compare(await readFile(existing), await readFile(from)) === 0;
      if (!same) problems.add(`${to} would be both ${existing} and ${from}, which differ`);
    }

    copies.set(to, from);
  };

  const seenDependencies = new Set<string>();

  for (const source of [...bundled.sources].sort()) {
    const dependency = dependencyOf(source);

    if (dependency !== undefined) {
      if (seenDependencies.has(dependency.dir)) continue;
      seenDependencies.add(dependency.dir);

      if (!existsSync(dependency.dir)) {
        const dir = relative(root, dependency.dir).split(sep).join("/");
        problems.add(`${dependency.name} is bundled from ${dir}, which is missing; rebuild`);
        continue;
      }

      const files = await licenseFiles(dependency.dir);
      if (files.length === 0) problems.add(`${dependency.name} has no license file`);
      for (const file of files) await add(`LICENSES/${dependency.name}/${file}`, join(dependency.dir, file));

      continue;
    }

    const path = relative(root, source).split(sep).join("/");
    if (path.startsWith("../") || isAbsolute(path)) {
      problems.add(`${source} is outside the repository`);
      continue;
    }

    if (!existsSync(source)) {
      problems.add(`${path} is bundled but missing`);
      continue;
    }

    const expression = await licenseOf(root, source, annotations);
    if (expression === undefined) {
      problems.add(`${path} has no license`);
      continue;
    }

    if (expression !== OWN) {
      for (const id of licenseIds(expression)) {
        const text = `LICENSES/${id}.txt`;

        if (existsSync(join(root, text))) await add(text, join(root, text));
        else problems.add(`${path} is ${expression}, but ${text} is missing`);
      }
    }

    for (const notice of notices[path] ?? []) {
      await add(`LICENSES/${basename(notice, ".txt")}-notice.txt`, join(root, notice));
    }
  }

  return {
    copies: [...copies].map(([to, from]) => ({ from, to })).sort(byDestination),
    problems: [...problems],
  };
}
