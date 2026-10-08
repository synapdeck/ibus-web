// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Plan } from "./plan.ts";

/** Lists, in the package directory, the files prepack wrote, for postpack to remove. */
export const MANIFEST = ".pack-licenses.json";

export class LicenseError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

export async function prepack(packageDir: string, plan: Plan): Promise<void> {
  if (plan.problems.length > 0) throw new LicenseError(plan.problems);

  // An interrupted pack leaves its copies and manifest behind.
  await postpack(packageDir);

  for (const { to } of plan.copies) {
    if (existsSync(join(packageDir, to))) throw new Error(`${to} exists, and pack-licenses didn't write it`);
  }

  for (const { from, to } of plan.copies) {
    await mkdir(dirname(join(packageDir, to)), { recursive: true });
    await copyFile(from, join(packageDir, to));
  }

  const written = plan.copies.map(({ to }) => to);
  await writeFile(join(packageDir, MANIFEST), `${JSON.stringify(written, null, 2)}\n`);
}

export async function postpack(packageDir: string): Promise<void> {
  const manifest = join(packageDir, MANIFEST);
  if (!existsSync(manifest)) return;

  const written = JSON.parse(await readFile(manifest, "utf8")) as readonly string[];
  const dirs = new Set<string>();

  for (const path of written) {
    await rm(join(packageDir, path), { force: true });
    for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) dirs.add(dir);
  }

  // Deepest first, so each is empty by the time it is reached unless
  // something else lives there.
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    await rmdir(join(packageDir, dir)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
    });
  }

  await rm(manifest);
}
