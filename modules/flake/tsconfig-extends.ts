// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Fails unless every tsconfig*.json git tracks, but the repository's base,
// reaches the base through `extends`, so every config shares its options.
//
//   tsconfig-extends.ts
//     Run from the repository root.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const base = path.resolve("tsconfig.base.json");

// tsconfig files are JSON with comments and trailing commas. Both are
// dropped outside strings; a comma is trailing when the next character that
// isn't whitespace or a comment closes an object or array.
const parseJsonc = (text: string): unknown => {
  let out = "";
  let pendingComma = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) throw new Error("unterminated comment");
      i = close + 1;
      continue;
    }
    if (/\s/.test(c)) {
      out += c;
      continue;
    }
    if (pendingComma && c !== "}" && c !== "]") out += ",";
    pendingComma = false;
    if (c === ",") {
      pendingComma = true;
    } else if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\") i++;
      }
      out += text.slice(start, i + 1);
    } else {
      out += c;
    }
  }
  return JSON.parse(out);
};

// Where a relative `extends` leads, as tsc resolves it: the path as written
// if that file exists, else with `.json` added.
const resolveExtends = (from: string, name: string) => {
  const resolved = path.resolve(path.dirname(from), name);
  if (existsSync(resolved) || resolved.endsWith(".json")) return resolved;
  return `${resolved}.json`;
};

// The configs `file` extends, as paths; a package name, which this can't
// follow, is kept as written.
const extendsOf = (file: string): string[] => {
  const config = parseJsonc(readFileSync(file, "utf8")) as { extends?: string | string[] };
  const named = config.extends === undefined ? [] : [config.extends].flat();
  return named.map((name) =>
    name.startsWith("./") || name.startsWith("../") || path.isAbsolute(name) ? resolveExtends(file, name) : name,
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
