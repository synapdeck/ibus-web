// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Vitest's configuration for the host's tests. IBUS_WEB_WORKER_HOST_TESTS
// names a JSON manifest of what they run against:
//
//   { "environments": ["node", "chromium", "firefox"],
//     "runtimes": { "asserting": DIR, "released": DIR },
//     "sides": DIR, "constants": FILE, "errno": FILE, "archives": DIR,
//     "pool": { "size": N, "planned": N, "engine": N, "glib": N, "lowWater": N },
//     "stress": { "threads": N, "rounds": N, "iterations": N } }
//
// Each runtime DIR holds ibus-runtime.js and ibus-runtime.wasm; sides holds
// the test side modules' .wasm files; constants is the build's JSON of the
// test side modules' opcodes and the runtime's values; archives holds the
// test archives of engine data and tree.json, which describes them. Under
// Node the hosts load all of it from disk but the archives, which they
// fetch from a server of this process's own; in a browser, from this
// server, as it is on disk, as are the host's own scripts from dist/.
//
// IBUS_WEB_MODULE_TESTS, when set, names a JSON description of an engine
// module's suite, which then runs under Node in place of the host's own:
//
//   { "suite": NAME, "dists": { NAME: DIR }, "heapBytes": N, "poolBase": N,
//     "texts": { NAME: FILE } }
//
// The suite is test/engines/<suite>.test.ts. Each DIR is a module
// distribution, served as module-<NAME>; each text is its FILE's contents.

import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { browserMode, crossOriginIsolation, servePlugin, serveDirs } from "@ibus-web/test-programs/vitest";
import type { TestProjectInlineConfiguration, ViteUserConfig } from "vitest/config";
import type { ModuleManifest } from "@ibus-web/protocol";
import type { BuildConstants, TestArchive, TestData } from "../shared/harness.ts";
import { commands } from "./commands.ts";

const environments = ["node", "chromium", "firefox"] as const;
type Environment = (typeof environments)[number];

interface Manifest {
  environments: Environment[];
  runtimes: { asserting: string; released: string };
  sides: string;
  constants: string;
  errno: string;
  archives: string;
  engines: Record<"echo" | "thrower" | "empty" | "rebuilt", string>;
  echoData: string;
  schemas: string;
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

interface ModuleTests {
  suite: string;
  dists: Record<string, string>;
  heapBytes: number;
  poolBase: number;
  texts: Record<string, string>;
}

const readModuleTests = (): ModuleTests | undefined => {
  const path = process.env["IBUS_WEB_MODULE_TESTS"];
  return path === undefined ? undefined : readJson<ModuleTests>(path);
};

// A module distribution's manifest, its files' URLs under base.
const moduleManifest = (dir: string, base: string): ModuleManifest => {
  const manifest = readJson<ModuleManifest>(join(dir, "manifest.json"));
  return {
    ...manifest,
    module: { ...manifest.module, url: `${base}${manifest.module.url}` },
    data: manifest.data.map((entry) => ({ ...entry, url: `${base}${entry.url}` })),
  };
};

const prefix = "/@ibus-web-worker-host/";
const dist = fileURLToPath(new URL("../../dist/", import.meta.url));

// The archives' description, as their build writes it.
type ArchiveDescription = Omit<TestArchive, "url"> & { upgrade: Omit<TestArchive, "url"> };

// Serves the directories by name under the prefix to the hosts under Node,
// which can't fetch a file: URL, from a server that stays up for as long as
// the tests run; resolves with its origin. The configuration has no
// teardown of its own, and every test file's hosts fetch from the server,
// so it is unref'd rather than closed: it goes when Vitest's process ends.
const serveToNode = async (dirs: Readonly<Record<string, string>>): Promise<string> => {
  const handle = serveDirs(prefix, dirs);
  const server = createServer((request, response) =>
    handle(request, response, () => {
      response.writeHead(404);
      response.end();
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

export const workerHostConfig = async (): Promise<ViteUserConfig> => {
  const manifest = readManifest();
  const moduleTests = readModuleTests();
  const moduleDirs = Object.fromEntries(
    Object.entries(moduleTests?.dists ?? {}).map(([name, dir]) => [`module-${name}`, dir]),
  );

  const { upgrade, ...tree } = readJson<ArchiveDescription>(join(manifest.archives, "tree.json"));
  const sideFiles = readdirSync(manifest.sides)
    .filter((file) => file.endsWith(".wasm"))
    .sort();
  // The host as released, with the relay that fails as the relay.js it
  // starts from beside itself. Copies, not links: Node would load a link's
  // target, and the host would find the relay beside that.
  const failing = mkdtempSync(join(tmpdir(), "ibus-web-worker-host-failing-relay-"));
  copyFileSync(join(dist, "worker/index.js"), join(failing, "index.js"));
  copyFileSync(join(dist, "worker/brotli-fallback.js"), join(failing, "brotli-fallback.js"));
  copyFileSync(join(dist, "test/worker/failing-relay.js"), join(failing, "relay.js"));
  const brokenRuntimes = Object.fromEntries(
    ["missingConstants", "malformedConstants"].map((name) => {
      const path = mkdtempSync(join(tmpdir(), `ibus-web-${name}-`));
      copyFileSync(join(manifest.runtimes.released, "ibus-runtime.wasm"), join(path, "ibus-runtime.wasm"));
      if (name === "malformedConstants") writeFileSync(join(path, "constants.json"), "{}");
      return [name, path];
    }),
  ) as Record<"missingConstants" | "malformedConstants", string>;
  type EngineName = "echo" | "thrower" | "empty" | "rebuilt";
  const engineManifest = (name: EngineName, url: (dir: EngineName, file: string) => string): ModuleManifest => {
    const engine = readJson<ModuleManifest>(join(manifest.engines[name], "manifest.json"));
    return {
      ...engine,
      module: { ...engine.module, url: url(name, engine.module.url) },
      data: engine.data.map((entry) => ({ ...entry, url: url(name, entry.url) })),
    };
  };
  const testData = (
    url: (
      dir:
        | "missingConstants"
        | "malformedConstants"
        | "asserting"
        | "released"
        | "sides"
        | "dist"
        | "failing"
        | "archives"
        | "echo"
        | "thrower"
        | "empty"
        | "rebuilt",
      file: string,
    ) => string,
  ): TestData => ({
    engines: {
      echo: engineManifest("echo", url),
      thrower: engineManifest("thrower", url),
      empty: engineManifest("empty", url),
      rebuilt: engineManifest("rebuilt", url),
    },
    echoData: manifest.echoData,
    schemaFiles: readdirSync(manifest.schemas, { recursive: true, withFileTypes: true }).filter((entry) =>
      entry.isFile(),
    ).length,
    brokenRuntimes: ["missingConstants", "malformedConstants"].map((name) =>
      url(name as "missingConstants" | "malformedConstants", "ibus-runtime.js"),
    ),
    runtimes: (["asserting", "released"] as const).map((name) => ({ name, url: url(name, "ibus-runtime.js") })),
    sides: sideFiles.map((file) => ({ name: basename(file, ".wasm"), url: url("sides", file) })),
    testHostUrl: url("dist", "test/worker/host.js"),
    hostUrl: url("dist", "worker/index.js"),
    hostWithFailingRelayUrl: url("failing", "index.js"),
    constants: readJson<BuildConstants>(manifest.constants),
    errno: readJson<Record<string, number>>(manifest.errno),
    pool: manifest.pool,
    stress: manifest.stress,
    archives: {
      tree: { ...tree, url: url("archives", tree.archive) },
      upgrade: { ...upgrade, url: url("archives", upgrade.archive) },
      missing: url("archives", "missing.tar"),
    },
  });
  const dirs = {
    ...manifest.engines,
    ...manifest.runtimes,
    ...brokenRuntimes,
    sides: manifest.sides,
    dist,
    failing,
    archives: manifest.archives,
  };
  const browsers = manifest.environments.filter((environment) => environment !== "node");
  const projects: TestProjectInlineConfiguration[] = [];
  const nodeOrigin = manifest.environments.includes("node")
    ? await serveToNode({
        ...manifest.engines,
        archives: manifest.archives,
        ...moduleDirs,
      })
    : undefined;
  if (nodeOrigin !== undefined)
    projects.push({
      extends: true,
      test: {
        name: "node",
        include: [moduleTests === undefined ? "test/node/**/*.test.ts" : `test/engines/${moduleTests.suite}.test.ts`],
        provide: {
          ...(moduleTests === undefined
            ? {}
            : {
                module: {
                  manifests: Object.fromEntries(
                    Object.entries(moduleTests.dists).map(([name, dir]) => [
                      name,
                      moduleManifest(dir, `${nodeOrigin}${prefix}module-${name}/`),
                    ]),
                  ),
                  heapBytes: moduleTests.heapBytes,
                  poolBase: moduleTests.poolBase,
                  texts: Object.fromEntries(
                    Object.entries(moduleTests.texts).map(([name, file]) => [name, readFileSync(file, "utf8")]),
                  ),
                },
              }),
          workerHost: testData((dir, file) =>
            dir === "archives" || dir === "echo" || dir === "thrower" || dir === "empty" || dir === "rebuilt"
              ? `${nodeOrigin}${prefix}${dir}/${file}`
              : pathToFileURL(join(dirs[dir], file)).href,
          ),
        },
      },
    });
  if (browsers.length > 0)
    projects.push({
      extends: true,
      test: {
        name: "browser",
        include: ["test/browser/**/*.test.ts"],
        provide: { workerHost: testData((dir, file) => `${prefix}${dir}/${file}`) },
        browser: browserMode(browsers, commands),
      },
    });
  const cacheDir = process.env["IBUS_WEB_TEST_CACHE_DIR"];
  return {
    ...(cacheDir === undefined ? {} : { cacheDir }),
    plugins: [servePlugin("ibus-web-worker-host", serveDirs(prefix, dirs))],
    // Found only as a browser test imports it, Effect would be optimized
    // then, and the page reloaded under the running tests. @effect/vitest
    // re-exports Vitest, which Vitest serves the browser itself.
    optimizeDeps: { include: ["effect"], exclude: ["@effect/vitest"] },
    server: { headers: crossOriginIsolation },
    test: {
      // Tests print what they measured.
      silent: false,
      // Hosts time what they do; one file at a time keeps them from
      // competing for the machine.
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
