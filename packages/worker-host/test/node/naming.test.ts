// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The names of storage made from engine names and versions, which may hold
// any character: none runs into another's.

import { describe, expect, test } from "vitest";
import {
  encodeComponent,
  engineDatabase,
  engineDataDatabasePrefix,
  engineDir,
  preloadKey,
  preloadOwner,
} from "../../src/shared/naming.ts";

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

  test("a preload's key names its engine and version, whatever they hold, beside the URL's own query", () => {
    for (const input of inputs) {
      for (const url of ["https://example.test/m.wasm", "https://example.test/m.wasm?v=1#top"]) {
        const engine = { name: input, version: `1.0+${input}` };
        const key = preloadKey(url, engine);
        expect(key, input).not.toContain("#");
        expect(key.startsWith(url.split("#")[0]!), input).toBe(true);
        expect(preloadOwner(key), input).toEqual({
          name: encodeComponent(engine.name),
          version: encodeComponent(engine.version),
        });
      }
    }
    expect(preloadOwner("https://example.test/m.wasm?v=1")).toBeUndefined();
  });

  test("no two versions of an engine share a preload's key", () => {
    const url = "https://example.test/m.wasm";
    expect(new Set(inputs.map((version) => preloadKey(url, { name: "a", version }))).size).toBe(inputs.length);
  });
});
