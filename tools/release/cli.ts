// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Prints a release's notes:
//
//   cli.ts <version> <package directory>...
//
// each directory holding the package.json naming the package and the
// CHANGELOG.md Changesets wrote, in the order the notes list them.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { releaseNotes } from "./notes.ts";

const [version, ...dirs] = process.argv.slice(2);
if (version === undefined || dirs.length === 0) {
  console.error("usage: cli.ts <version> <package directory>...");
  process.exit(1);
}

const changelogs = dirs.map((dir) => ({
  name: (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string }).name,
  text: readFileSync(join(dir, "CHANGELOG.md"), "utf8"),
}));
process.stdout.write(releaseNotes(version, changelogs));
