// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Vitest's configuration for a run of test programs. IBUS_WEB_TEST_PROGRAMS
// names a JSON manifest:
//
//   { "timeout": SECONDS, "environments": ["node", "chromium", "firefox"],
//     "programs": [{ "name": NAME, "dir": DIR,
//                    "format": "gtest-json" | "tap" }, ...],
//     "nodeTests": { "dir": DIR, "data": { KEY: VALUE, ... } } }
//
// DIR holds NAME.js and NAME.wasm and, optionally, NAME.args, the program's
// arguments one per line. Programs named PREFIX.1, PREFIX.2 and so on form a
// sequence that runs in that order and shares its storage. nodeTests, which
// may be left out, names a directory whose *.test.ts files run in the node
// environment beside the programs, for what a program can't report on
// itself; they read data, paths to what they test, say, with nodeTestData()
// from @ibus-web/test-programs/node-tests. With nodeTests, programs may be
// empty.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { TestProjectInlineConfiguration, ViteUserConfig } from "vitest/config";
import type { Format, Plan, Program } from "../shared/protocol.ts";
import { commands } from "./commands.ts";
import { browserMode, crossOriginIsolation, servePlugin, serveDirs } from "./vitest.ts";

const environments = ["node", "chromium", "firefox"] as const;
type Environment = (typeof environments)[number];

interface Manifest {
  timeout: number;
  environments: Environment[];
  programs: { name: string; format: Format; dir: string }[];
  nodeTests?: { dir: string; data: Record<string, string> };
}

const readManifest = (): Manifest => {
  const path = process.env["IBUS_WEB_TEST_PROGRAMS"];
  if (path === undefined) throw new Error("IBUS_WEB_TEST_PROGRAMS must name the manifest of the programs to run");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  if (!(manifest.timeout > 0)) throw new Error(`${path}: timeout must be positive, not ${manifest.timeout}`);
  for (const environment of manifest.environments)
    if (!environments.includes(environment)) throw new Error(`${path}: no environment ${environment}`);
  for (const { name, format } of manifest.programs)
    if (!["gtest-json", "tap"].includes(format)) throw new Error(`${path}: ${name}'s format is ${format}`);
  if (manifest.nodeTests !== undefined && !manifest.environments.includes("node"))
    throw new Error(`${path}: nodeTests run in the node environment, which isn't among the environments`);
  return manifest;
};

// The programs' directories, by index, and the Worker that runs them, under
// this prefix.
const prefix = "/@ibus-web-test-programs/";

const readArgs = (dir: string, name: string): string[] => {
  let text: string;
  try {
    text = readFileSync(join(dir, `${name}.args`), "utf8");
  } catch {
    return [];
  }
  const args = text.split("\n");
  // The file's final newline ends the last argument rather than adding an
  // empty one.
  if (args.at(-1) === "") args.pop();
  return args;
};

const sequence = /^(.+)\.([1-9][0-9]*)$/;

// Groups the programs by storage, in the order each group's first program
// appears.
const planOf = (manifest: Manifest): Plan => {
  const groups = new Map<string, Program[]>();
  for (const [index, { name, format, dir }] of manifest.programs.entries()) {
    const key = sequence.exec(name)?.[1] ?? name;
    const group = groups.get(key) ?? [];
    if (group.some((program) => program.name === name)) throw new Error(`two programs are named ${name}`);
    group.push({ name, format, dir, url: `${prefix}${index}/${name}.js`, args: readArgs(dir, name) });
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    if (group.length === 1 && group[0]!.name === key) continue;
    if (group.some(({ name }) => name === key)) throw new Error(`${key} can't run both on its own and as a sequence`);
    group.sort((a, b) => Number(sequence.exec(a.name)![2]) - Number(sequence.exec(b.name)![2]));
    for (const [index, { name }] of group.entries())
      if (name !== `${key}.${index + 1}`)
        throw new Error(`${key}: the sequence must be numbered from 1 without gaps, not ${name}`);
  }
  return { timeoutMs: manifest.timeout * 1000, groups: [...groups.values()] };
};

export const testProgramsConfig = (): ViteUserConfig => {
  const manifest = readManifest();
  const plan = planOf(manifest);
  const browsers = manifest.environments.filter((environment) => environment !== "node");
  const projects: TestProjectInlineConfiguration[] = [];
  if (manifest.environments.includes("node")) {
    projects.push({
      extends: true,
      test: {
        name: "node",
        include: [
          // Collected without programs, it would fail as a file with no tests.
          ...(manifest.programs.length === 0 ? [] : ["dist/node/programs.test.js"]),
          ...(manifest.nodeTests === undefined ? [] : [join(manifest.nodeTests.dir, "**/*.test.ts")]),
        ],
        runner: "./dist/node/runner.js",
      },
    });
  }
  if (browsers.length > 0) {
    projects.push({
      extends: true,
      test: {
        name: "browser",
        include: ["dist/browser/programs.test.js"],
        browser: browserMode(browsers, commands),
      },
    });
  }
  const cacheDir = process.env["IBUS_WEB_TEST_CACHE_DIR"];
  return {
    ...(cacheDir === undefined ? {} : { cacheDir }),
    plugins: [
      servePlugin(
        "ibus-web-test-programs",
        serveDirs(prefix, {
          ...Object.fromEntries(manifest.programs.map(({ dir }, index) => [String(index), dir])),
          worker: fileURLToPath(new URL("../../dist/worker/", import.meta.url)),
        }),
      ),
    ],
    // Test files outside the package, which have no node_modules of their
    // own to find it in.
    resolve: {
      alias: {
        "@ibus-web/test-programs/node-tests": fileURLToPath(new URL("../../dist/node/node-tests.js", import.meta.url)),
      },
    },
    server: { headers: crossOriginIsolation },
    test: {
      provide: { testPrograms: plan, nodeTestData: manifest.nodeTests?.data ?? {} },
      // A program runs in its suite's beforeAll, and has its own limit.
      hookTimeout: plan.timeoutMs + 60_000,
      // A program's output is logged inside each of its tests, to be shown
      // only when the test fails.
      silent: "passed-only",
      // Programs time themselves; one environment at a time keeps them from
      // competing for the machine.
      fileParallelism: false,
      projects,
    },
  };
};
