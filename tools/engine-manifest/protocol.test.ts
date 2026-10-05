// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

let dir: string;
let protocol: string;

// Stands in for the protocol package's build: its version, and a decoder
// that refuses a manifest naming another protocol or outside the bounds.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ibus-web-manifest-protocol-"));
  protocol = join(dir, "index.js");
  writeFileSync(
    protocol,
    `export const PROTOCOL_VERSION = 7;
export const decodeEngineManifest = (manifest, { minimum, maximum }) => {
  if (manifest.protocol !== 7 || manifest.memory < minimum || manifest.memory > maximum) throw new Error("refused");
  return manifest;
};
`,
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (...args: string[]): string =>
  execFileSync(process.execPath, [new URL("./protocol.ts", import.meta.url).pathname, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });

const manifest = (fields: object): string => {
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify(fields));
  return path;
};

it("prints the protocol's version", () => {
  expect(run("version", protocol)).toBe("7\n");
});

it("checks a manifest with the protocol's decoder and the runtime's bounds", () => {
  expect(run("check", protocol, manifest({ protocol: 7, memory: 2 }), "1", "3")).toBe("");
  expect(() => run("check", protocol, manifest({ protocol: 7, memory: 4 }), "1", "3")).toThrow("refused");
  expect(() => run("check", protocol, manifest({ protocol: 6, memory: 2 }), "1", "3")).toThrow("refused");
});
