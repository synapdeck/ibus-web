// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { cleanUp, makeTree, own, sourceMap } from "./fixture.ts";

afterEach(cleanUp);

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

const repository = (source: string) =>
  makeTree({
    "REUSE.toml": "version = 1\n",
    "LICENSE-MIT": "",
    "LICENSE-APACHE": "",
    "packages/p/package.json": JSON.stringify({ name: "p", files: ["dist"] }),
    "packages/p/src/a.ts": source,
    "packages/p/dist/index.js": "",
    "packages/p/dist/index.js.map": sourceMap("../src/a.ts"),
  });

test("check lists the copies for a package it can account for", async () => {
  const root = await repository(own());
  const result = run("check", join(root, "packages/p"));

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("LICENSE-MIT <- ");
});

test("check fails and names what it can't account for", async () => {
  const root = await repository("export {};\n");
  const result = run("check", join(root, "packages/p"));

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("packages/p/src/a.ts has no license");
});

test("an unknown command is a usage error", () => {
  expect(run("publish").status).toBe(2);
});
