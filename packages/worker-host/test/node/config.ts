// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Vitest's configuration for the host's tests. IBUS_WEB_WORKER_HOST_TESTS
// names a JSON manifest of what they run against:
//
//   { "environments": ["node", "chromium", "firefox"],
//     "runtimes": { "asserting": DIR, "released": DIR },
//     "sides": DIR, "constants": FILE, "errno": FILE,
//     "pool": { "size": N, "planned": N, "engine": N, "glib": N, "lowWater": N },
//     "stress": { "threads": N, "rounds": N, "iterations": N } }
//
// Each runtime DIR holds ibus-runtime.js and ibus-runtime.wasm; sides holds
// the test side modules' .wasm files; constants is the build's JSON of the
// test side modules' opcodes and the runtime's values. Under Node the hosts
// load all of it from disk; in a browser, from this server, as it is on
// disk, as are the host's own scripts from dist/.

import { copyFileSync, createReadStream, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, resolve as resolvePath, sep } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { pipeline } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import type { Plugin, TestProjectInlineConfiguration, ViteUserConfig } from "vitest/config";
import type { BuildConstants, TestData } from "../shared/harness.ts";
import { commands } from "./commands.ts";

const environments = ["node", "chromium", "firefox"] as const;
type Environment = (typeof environments)[number];

interface Manifest {
  environments: Environment[];
  runtimes: { asserting: string; released: string };
  sides: string;
  constants: string;
  errno: string;
  pool: TestData["pool"];
  stress: TestData["stress"];
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const readManifest = (): Manifest => {
  const path = process.env["IBUS_WEB_WORKER_HOST_TESTS"];
  if (path === undefined) throw new Error("IBUS_WEB_WORKER_HOST_TESTS must name the manifest of what the tests run");
  const manifest = readJson<Manifest>(path);
  for (const environment of manifest.environments)
    if (!environments.includes(environment)) throw new Error(`${path}: no environment ${environment}`);
  return manifest;
};

const prefix = "/@ibus-web-worker-host/";
const dist = fileURLToPath(new URL("../../dist/", import.meta.url));

// Every response, errors included, carries the headers that make a page
// cross-origin isolated, which SharedArrayBuffer needs.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;

const types: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

// Serves the directories by name under the prefix, as they are on disk:
// Vite would rewrite their module scripts.
const serveRaw = (dirs: Readonly<Record<string, string>>): Plugin => {
  const resolve = (pathname: string): string | undefined => {
    const [name, ...rest] = pathname.slice(prefix.length).split("/");
    const dir = dirs[name ?? ""];
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
    if (!pathname.startsWith(prefix)) return next();
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
    name: "ibus-web-worker-host",
    configureServer: (server) => {
      server.middlewares.use(handle);
    },
    // Vite warns that it can't analyze a dynamic import in Vitest's own
    // module runner, which every browser test file pulls in to reach Vitest.
    // Vitest drops the same warning from its own server's log, but not from
    // the browser server's.
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

export const workerHostConfig = (): ViteUserConfig => {
  const manifest = readManifest();
  const sideFiles = readdirSync(manifest.sides)
    .filter((file) => file.endsWith(".wasm"))
    .sort();
  // The host as released, with the relay that fails as the relay.js it
  // starts from beside itself. Copies, not links: Node would load a link's
  // target, and the host would find the relay beside that.
  const failing = mkdtempSync(join(tmpdir(), "ibus-web-worker-host-failing-relay-"));
  copyFileSync(join(dist, "worker/index.js"), join(failing, "index.js"));
  copyFileSync(join(dist, "test/worker/failing-relay.js"), join(failing, "relay.js"));
  const testData = (
    url: (dir: "asserting" | "released" | "sides" | "dist" | "failing", file: string) => string,
  ): TestData => ({
    runtimes: (["asserting", "released"] as const).map((name) => ({ name, url: url(name, "ibus-runtime.js") })),
    sides: sideFiles.map((file) => ({ name: basename(file, ".wasm"), url: url("sides", file) })),
    testHostUrl: url("dist", "test/worker/host.js"),
    hostUrl: url("dist", "worker/index.js"),
    hostWithFailingRelayUrl: url("failing", "index.js"),
    constants: readJson<BuildConstants>(manifest.constants),
    errno: readJson<Record<string, number>>(manifest.errno),
    pool: manifest.pool,
    stress: manifest.stress,
  });
  const dirs = { ...manifest.runtimes, sides: manifest.sides, dist, failing };
  const browsers = manifest.environments.filter((environment) => environment !== "node");
  if (browsers.length > 0) dropSkippingValidation();
  const projects: TestProjectInlineConfiguration[] = [];
  if (manifest.environments.includes("node"))
    projects.push({
      extends: true,
      test: {
        name: "node",
        include: ["test/node/**/*.test.ts"],
        provide: { workerHost: testData((dir, file) => pathToFileURL(join(dirs[dir], file)).href) },
      },
    });
  if (browsers.length > 0)
    projects.push({
      extends: true,
      test: {
        name: "browser",
        include: ["test/browser/**/*.test.ts"],
        provide: { workerHost: testData((dir, file) => `${prefix}${dir}/${file}`) },
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
  const cacheDir = process.env["IBUS_WEB_TEST_CACHE_DIR"];
  return {
    ...(cacheDir === undefined ? {} : { cacheDir }),
    plugins: [serveRaw(dirs)],
    // Found only as a browser test imports it, Effect would be optimized
    // then, and the page reloaded under the running tests. @effect/vitest
    // re-exports Vitest, which Vitest serves the browser itself.
    optimizeDeps: { include: ["effect"], exclude: ["@effect/vitest"] },
    server: { headers: isolation },
    test: {
      // Hosts time what they do; one file at a time keeps them from
      // competing for the machine.
      // Tests print what they measured.
      silent: false,
      fileParallelism: false,
      // Hosts start Workers of their own, which a test process in a
      // worker_thread would nest.
      pool: "forks",
      testTimeout: 120_000,
      hookTimeout: 120_000,
      projects,
    },
  };
};
