// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Copies the license texts a package's bundle needs into it while npm packs
// it, and removes them afterwards:
//
//   node cli.ts prepack|postpack|check [package directory]
//
// check prints what prepack would copy, and fails on any bundled file whose
// license it can't find.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NOTICES } from "./notices.ts";
import { LicenseError, postpack, prepack } from "./pack.ts";
import { planLicenses } from "./plan.ts";

function repositoryRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "REUSE.toml"))) return dir;
    if (dirname(dir) === dir) throw new Error(`no REUSE.toml in ${from} or above it`);
  }
}

// The map's entries for files this repository has: a notice missing for a
// file that exists is a problem, but a tree without the file isn't one the
// map is about.
const presentNotices = (root: string) =>
  Object.fromEntries(Object.entries(NOTICES).filter(([source]) => existsSync(join(root, source))));

const plan = (packageDir: string) => {
  const root = repositoryRoot(packageDir);

  return planLicenses(root, packageDir, presentNotices(root));
};

const [command, directory = "."] = process.argv.slice(2);
const packageDir = resolve(directory);

try {
  switch (command) {
    case "prepack":
      await prepack(packageDir, await plan(packageDir));
      break;

    case "postpack":
      await postpack(packageDir);
      break;

    case "check": {
      const { copies, problems } = await plan(packageDir);
      if (problems.length > 0) throw new LicenseError(problems);

      for (const { from, to } of copies) console.log(`${to} <- ${from}`);
      break;
    }

    default:
      console.error("usage: node cli.ts prepack|postpack|check [package directory]");
      process.exitCode = 2;
  }
} catch (error) {
  if (!(error instanceof LicenseError)) throw error;

  for (const problem of error.problems) console.error(`pack-licenses: ${packageDir}: ${problem}`);
  process.exitCode = 1;
}
