// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Fails unless every tsconfig*.json git tracks reaches one of
// @ibus-web/tsconfig's presets through `extends`, so every config shares
// the repository's standard options. The presets, which aren't named
// tsconfig*.json, are the roots. A solution config (`"files": []` plus
// `references`) sets no options of its own and is exempt.
//
//   tsconfig-extends.ts
//     Run from the repository root.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";

const presetPackage = "@ibus-web/tsconfig";
const presetDirectory = path.resolve("packages/tsconfig");

// tsconfig files are JSON with comments and trailing commas.
const parseJsonc = (text: string): unknown => {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const [{ error, offset }] = errors as [ParseError];
    throw new Error(`${printParseErrorCode(error)} at offset ${offset}`);
  }
  return value;
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

const isPreset = (parent: string) =>
  parent.startsWith(`${presetPackage}/`) || (path.isAbsolute(parent) && path.dirname(parent) === presetDirectory);

const isSolution = (file: string) => {
  const config = parseJsonc(readFileSync(file, "utf8")) as { files?: unknown[]; references?: unknown[] };
  return config.files?.length === 0 && config.references !== undefined;
};

const reachesPreset = (file: string, seen = new Set<string>()): boolean => {
  if (seen.has(file)) return false;
  seen.add(file);
  return extendsOf(file).some((parent) => isPreset(parent) || (path.isAbsolute(parent) && reachesPreset(parent, seen)));
};

const files = execFileSync("git", ["ls-files", "-z", "--", ":(glob)**/tsconfig*.json"], { encoding: "utf8" })
  .split("\0")
  .filter((file) => file !== "");

const failures = files.filter((file) => {
  try {
    return !isSolution(file) && !reachesPreset(path.resolve(file));
  } catch (error) {
    console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
});
for (const file of failures) {
  console.error(`${file}: doesn't extend an ${presetPackage} preset, directly or through another config`);
}
if (failures.length > 0) process.exit(1);
