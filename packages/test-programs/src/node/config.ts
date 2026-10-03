// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Vitest's configuration for a run of test programs. IBUS_WEB_TEST_PROGRAMS
// names a JSON manifest:
//
//   { "timeout": SECONDS, "environments": ["node", "chromium", "firefox"],
//     "programs": [{ "name": NAME, "dir": DIR,
//                    "format": "gtest-json" | "tap" }, ...],
//     "nodeTests": { "files": [PATH, ...], "data": { KEY: VALUE, ... } } }
//
// DIR holds NAME.js and NAME.wasm and, optionally, NAME.args, the program's
// arguments one per line. Programs named PREFIX.1, PREFIX.2 and so on form a
// sequence that runs in that order and shares its storage. nodeTests, which
// may be left out, are Vitest test files run in the node environment beside
// the programs, for what a program can't report on itself; they read data,
// paths to what they test, say, with inject("nodeTestData").

import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve as resolvePath, sep } from "node:path";
import process from "node:process";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import type { Plugin, TestProjectInlineConfiguration, ViteUserConfig } from "vitest/config";
import type { Format, Plan, Program } from "../shared/protocol.ts";
import { commands } from "./commands.ts";

const environments = ["node", "chromium", "firefox"] as const;
type Environment = (typeof environments)[number];

interface Manifest {
  timeout: number;
  environments: Environment[];
  programs: { name: string; format: Format; dir: string }[];
  nodeTests?: { files: string[]; data: Record<string, string> };
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

const programsPrefix = "/@ibus-web-test-programs/programs/";

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
    group.push({ name, format, dir, url: `${programsPrefix}${index}/${name}.js`, args: readArgs(dir, name) });
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

// Every response, errors included, carries the headers that make a page
// cross-origin isolated, which SharedArrayBuffer, and so any program with
// threads, needs.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;

const types: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

// Serves the programs and the Worker that runs them as they are on disk:
// Vite would rewrite their module scripts.
const servePrograms = (dirs: readonly string[]): Plugin => {
  const worker = fileURLToPath(new URL("../../dist/worker/program.js", import.meta.url));
  const resolve = (pathname: string): string | undefined => {
    if (pathname === "/@ibus-web-test-programs/worker.js") return worker;
    if (!pathname.startsWith(programsPrefix)) return undefined;
    const [index, ...rest] = pathname.slice(programsPrefix.length).split("/");
    const dir = dirs[Number(index)];
    if (dir === undefined) return undefined;
    const root = resolvePath(dir);
    const file = join(root, rest.join("/"));
    return file.startsWith(root + sep) ? file : undefined;
  };
  const fail = (response: ServerResponse, status: number): void => {
    response.writeHead(status, { ...isolation, "Content-Type": "text/plain; charset=utf-8" });
    response.end(`${status}\n`);
  };
  const handle = (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      return next();
    }
    if (!pathname.startsWith("/@ibus-web-test-programs/")) return next();
    const file = resolve(pathname);
    const type = file === undefined ? undefined : types[extname(file)];
    if (file === undefined || type === undefined) return fail(response, 404);
    stat(file).then(
      (info) => {
        if (!info.isFile()) return fail(response, 404);
        response.writeHead(200, {
          ...isolation,
          "Content-Type": type,
          "Content-Length": info.size,
          "Cache-Control": "no-store",
        });
        if (request.method === "HEAD") response.end();
        // The status is out by now, so a read that fails can only cut the
        // response short, which pipeline() does by destroying it.
        else pipeline(createReadStream(file), response, () => {});
      },
      () => fail(response, 404),
    );
  };
  return {
    name: "ibus-web-test-programs",
    configureServer: (server) => {
      server.middlewares.use(handle);
    },
    // Vite warns that it can't analyze a dynamic import in Vitest's own
    // module runner, which the browser test file pulls in to reach
    // TestRunner. Vitest drops the same warning from its own server's log,
    // but not from the browser server's.
    configResolved: (config) => {
      const { logger } = config;
      const warn = logger.warn.bind(logger);
      logger.warn = (message, options) => {
        if (message.includes(UNANALYZABLE_IMPORT) && message.includes("vite_module-runner")) return;
        warn(message, options);
      };
    },
  };
};

const UNANALYZABLE_IMPORT = "The above dynamic import cannot be analyzed by Vite";

// Playwright says so on stderr every time it launches a browser, which it
// does with host validation off because Nix, not the host's packages,
// provides the browsers' libraries.
const SKIPPING_VALIDATION = "Skipping host requirements validation";
const dropSkippingValidation = (): void => {
  const write = process.stderr.write.bind(process.stderr) as (...args: unknown[]) => boolean;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) =>
    typeof chunk === "string" && chunk.startsWith(SKIPPING_VALIDATION)
      ? true
      : write(chunk, ...rest)) as typeof process.stderr.write;
};

// Playwright turns Chromium's own sandbox off unless asked; runs keep it on,
// as a browser would, unless IBUS_WEB_CHROMIUM_SANDBOX=0.
const chromiumSandbox = process.env["IBUS_WEB_CHROMIUM_SANDBOX"] !== "0";

export const testProgramsConfig = (): ViteUserConfig => {
  const manifest = readManifest();
  const plan = planOf(manifest);
  const browsers = manifest.environments.filter((environment) => environment !== "node");
  if (browsers.length > 0) dropSkippingValidation();
  const projects: TestProjectInlineConfiguration[] = [];
  if (manifest.environments.includes("node")) {
    projects.push({
      extends: true,
      test: {
        name: "node",
        include: ["dist/node/programs.test.js", ...(manifest.nodeTests?.files ?? [])],
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
        browser: {
          enabled: true,
          headless: true,
          // A page shows nothing a test asserts on.
          screenshotFailures: false,
          commands,
          instances: browsers.map((browser) => ({
            browser,
            name: browser,
            provider: playwright({ launchOptions: browser === "chromium" ? { chromiumSandbox } : {} }),
          })),
        },
      },
    });
  }
  const cacheDir = process.env["IBUS_WEB_TEST_CACHE_DIR"];
  return {
    ...(cacheDir === undefined ? {} : { cacheDir }),
    plugins: [servePrograms(manifest.programs.map(({ dir }) => dir))],
    server: { headers: isolation },
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
