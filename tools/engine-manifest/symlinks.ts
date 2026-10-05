// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// An engine's data is installed as its closure's store paths and nothing
// else, so a link in it that leads anywhere but into one of them dangles
// where the engine runs, however it resolves on the machine that built it.

import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Linux's limit on links followed in one lookup.
const MAX_HOPS = 40;

const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

// Where path leads, following every link on the way, or a reason it leads
// nowhere in the closure. Each step is taken as the engine's file system
// takes it, which holds only the roots: a path that is neither in one nor
// one of their ancestors doesn't exist there, even on the way to one.
const resolve = (path: string, roots: readonly string[]): { to: string } | { reason: string } => {
  const parts = path.split("/").filter((part) => part !== "");
  let current = "/";
  let hops = 0;
  while (parts.length > 0) {
    const part = parts.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    if (!roots.some((root) => within(next, root))) {
      if (!roots.some((root) => root.startsWith(`${next}/`))) return { reason: `${next} is outside the closure` };
      current = next;
      continue;
    }
    let link: string | undefined;
    try {
      if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next);
    } catch {
      return { reason: `${next} does not exist` };
    }
    if (link === undefined) {
      current = next;
      continue;
    }
    if (++hops > MAX_HOPS) return { reason: `more than ${MAX_HOPS} links` };
    parts.unshift(...link.split("/").filter((piece) => piece !== ""));
    if (link.startsWith("/")) current = "/";
  }
  return roots.some((root) => within(current, root))
    ? { to: current }
    : { reason: `${current} is outside the closure` };
};

// Every link at or under path.
const linksUnder = (path: string): string[] => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path)
    .sort()
    .flatMap((name) => linksUnder(join(path, name)));
};

// One line for each link in the closure of roots that doesn't resolve to a
// path in it.
export const closureLinkProblems = (roots: readonly string[]): string[] =>
  roots.flatMap(linksUnder).flatMap((link) => {
    const found = resolve(link, roots);
    return "reason" in found ? [`${link} -> ${readlinkSync(link)}: ${found.reason}`] : [];
  });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [list, ...excluded] = process.argv.slice(2);
  if (!list) throw new Error("usage: symlinks.ts STORE-PATHS [EXCLUDED...]");
  const roots = readFileSync(list, "utf8")
    .split("\n")
    .filter((path) => path !== "" && !excluded.includes(path));
  const problems = closureLinkProblems(roots);
  if (problems.length > 0) {
    process.stderr.write(`links that leave the engine's data:\n${problems.map((line) => `  ${line}\n`).join("")}`);
    process.exit(1);
  }
}
