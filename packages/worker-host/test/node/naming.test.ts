// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The names of storage made from engine names and versions, which may hold
// any character: none runs into another's.

import { describe, expect, test } from "vitest";
import { encodeComponent, engineDatabase, engineDataDatabasePrefix, engineDir } from "../../src/shared/naming.ts";

describe("storage-names", () => {
  const inputs = ["/", ":", ".", "..", "a/b:c", "%2F"];

  test("an encoded name or version has no / or :, and is never . or ..", () => {
    for (const input of inputs) {
      const encoded = encodeComponent(input);
      expect(encoded, input).not.toMatch(/[/:]/);
      expect([".", ".."], input).not.toContain(encoded);
    }
  });

  test("no two names encode alike", () => {
    expect(new Set(inputs.map(encodeComponent)).size).toBe(inputs.length);
  });

  test("an engine's directory is one component under /engines, whatever its name", () => {
    for (const input of inputs) {
      const [root, component, ...rest] = engineDir({ name: input }).slice(1).split("/");
      expect(root, input).toBe("engines");
      expect(rest, input).toEqual([]);
      expect(["", ".", ".."], input).not.toContain(component);
    }
  });

  test("engine a/data/x's database isn't one of engine a's data databases", () => {
    expect(engineDatabase({ name: "a/data/x" }).startsWith(engineDataDatabasePrefix({ name: "a" }))).toBe(false);
  });
});
