// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Fails unless every tsconfig*.json git tracks, but the repository's base,
// reaches the base through `extends`, so every config shares its options.
//
//   tsconfig-extends.ts
//     Run from the repository root.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const base = path.resolve("tsconfig.base.json");

// tsconfig files are JSON with comments and trailing commas.
const parseJsonc = (text: string): unknown => {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\") i++;
      }
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) throw new Error("unterminated comment");
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
};

// The configs `file` extends, as paths; a package name, which this can't
// follow, is kept as written.
const extendsOf = (file: string): string[] => {
  const config = parseJsonc(readFileSync(file, "utf8")) as { extends?: string | string[] };
  const named = config.extends === undefined ? [] : [config.extends].flat();
  return named.map((name) =>
    name.startsWith("./") || name.startsWith("../") || path.isAbsolute(name)
      ? path.resolve(path.dirname(file), name)
      : name,
  );
};

const reachesBase = (file: string, seen = new Set<string>()): boolean => {
  if (seen.has(file)) return false;
  seen.add(file);
  return extendsOf(file).some((parent) => parent === base || (path.isAbsolute(parent) && reachesBase(parent, seen)));
};

const files = execFileSync("git", ["ls-files", "-z", "--", "*tsconfig*.json"], { encoding: "utf8" })
  .split("\0")
  .filter((file) => file !== "" && path.resolve(file) !== base);

const failures = files.filter((file) => {
  try {
    return !reachesBase(path.resolve(file));
  } catch (error) {
    console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
});
for (const file of failures) {
  console.error(`${file}: doesn't extend tsconfig.base.json, directly or through another config`);
}
if (failures.length > 0) process.exit(1);
