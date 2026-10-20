// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { EngineDescriptor } from "../../src/descriptor.ts";
import * as root from "../../src/index.ts";
import { specifiers } from "../support/specifiers.ts";

const packageDir = fileURLToPath(new URL("../../", import.meta.url));

// What a built file imports, following the package's own chunks into what
// they import.
const imported = (path: string): Set<string> =>
  new Set(
    specifiers(readFileSync(path, "utf8")).flatMap((specifier) =>
      specifier.startsWith("./") ? [...imported(join(dirname(path), specifier))] : [specifier],
    ),
  );

describe("the descriptor subpath", () => {
  test("imports only effect once built", () => {
    for (const file of ["dist/descriptor.js", "dist/descriptor.d.ts"])
      expect(imported(join(packageDir, file))).toEqual(new Set(["effect"]));
  });

  test("exports the descriptor's schema and type alone", async () => {
    const built = (await import(join(packageDir, "dist/descriptor.js"))) as Record<string, unknown>;
    const types = readFileSync(join(packageDir, "dist/descriptor.d.ts"), "utf8");

    expect(Object.keys(built)).toEqual(["EngineDescriptor"]);
    expect(types).not.toMatch(/\b(?:nonEmpty|storePath)\b/);
  });

  test("is the package's descriptor export", () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

    expect(manifest.exports["./descriptor"]).toEqual({
      types: "./dist/descriptor.d.ts",
      default: "./dist/descriptor.js",
    });
  });

  test("holds the schema the root entry exports", () => {
    expect(root.EngineDescriptor).toBe(EngineDescriptor);
  });

  test("decodes a descriptor, its data optional", () => {
    const descriptor = {
      name: "hangul",
      displayName: "Hangul",
      languages: ["ko"],
      keyboard: { layout: "us", passThrough: [] },
    };

    expect(Schema.decodeUnknownSync(EngineDescriptor)(descriptor)).toEqual(descriptor);
    expect(() => Schema.decodeUnknownSync(EngineDescriptor)({ ...descriptor, displayName: "" })).toThrow();
    expect(() => Schema.decodeUnknownSync(EngineDescriptor)({ ...descriptor, data: ["/tmp/data"] })).toThrow();
  });
});
