// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MODULE_ABI } from "@ibus-web/protocol/module-script";
import { describe, expect, test } from "vitest";
import * as kit from "../src/index.ts";

const distJs = fileURLToPath(new URL("../dist/index.js", import.meta.url));

// Any module specifier at all: static and dynamic imports and re-exports.
const specifiers = (source: string): string[] =>
  [
    ...source.matchAll(/\bimport\s*(?:type\b[^'"]*?)?(?:[\w$*{}\s,]+from\s*)?["']([^"']+)["']/g),
    ...source.matchAll(/\bexport\s*(?:type\s*)?(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
  ].map((match) => match[1]!);

describe("the root entry", () => {
  test("re-exports the contract's version", () => {
    expect(kit.MODULE_ABI).toBe(MODULE_ABI);
  });

  test("imports only effect and protocol subpaths that import only effect or nothing once built", () => {
    const imported = new Set(specifiers(readFileSync(distJs, "utf8")));
    const require = createRequire(import.meta.url);

    // What a built file imports but its own package's chunks, which are
    // followed into.
    const outside = (path: string): string[] =>
      specifiers(readFileSync(path, "utf8")).flatMap((specifier) =>
        specifier.startsWith("./") ? outside(fileURLToPath(new URL(specifier, pathToFileURL(path)))) : [specifier],
      );

    expect(imported).toEqual(new Set(["@ibus-web/protocol/descriptor", "@ibus-web/protocol/module-script", "effect"]));
    for (const subpath of ["@ibus-web/protocol/descriptor", "@ibus-web/protocol/module-script"])
      expect(outside(require.resolve(subpath)).filter((specifier) => specifier !== "effect")).toEqual([]);
  });
});
