// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The fixture module built with the plugin in each bundler it supports, against
// the command line's build of the same source bundled by esbuild alone, and
// served by Vite's dev server against Vite's build.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import esbuildPlugin from "@ibus-web/module-kit/esbuild";
import rolldownPlugin from "@ibus-web/module-kit/rolldown";
import rollupPlugin from "@ibus-web/module-kit/rollup";
import rspackPlugin from "@ibus-web/module-kit/rspack";
import vitePlugin from "@ibus-web/module-kit/vite";
import webpackPlugin from "@ibus-web/module-kit/webpack";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terserPlugin from "@rollup/plugin-terser";
import { rspack } from "@rspack/core";
import * as esbuild from "esbuild";
import { init, parse } from "es-module-lexer";
import { rolldown } from "rolldown";
import { rollup, type Plugin as RollupPlugin } from "rollup";
import { createServer, build as viteBuild, type Logger, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import webpack from "webpack";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixture/module.js");
const pinyinTones = fileURLToPath(import.meta.resolve("@ibus-web/example-pinyin-tones/module"));
const typescriptLoader = join(here, "fixture/typescript-loader.mjs");
const refused = join(here, "fixture/refused.js");
const cli = join(dirname(fileURLToPath(import.meta.resolve("@ibus-web/module-kit/build"))), "cli.js");

const moduleDir = "ibus-module/bundled-fixture";

// The modules the bundlers build, by the name they build under, with the
// version each declares.
const modules = {
  "bundled-fixture": { entry: fixture, version: "1.0.0" },
  "pinyin-tones": { entry: pinyinTones, version: "1.0.0" },
} as const;

// The package's declarations are read as CommonJS, whose default export is
// the module object, but Node loads its ES build, whose default is the plugin.
const terser = terserPlugin as unknown as typeof terserPlugin.default;

// Rollup reads only JavaScript, so a TypeScript module needs a plugin to
// strip its types.
const typescript = (): RollupPlugin => ({
  name: "typescript",
  async transform(code, id) {
    if (!id.endsWith(".ts")) return null;

    const { code: stripped } = await esbuild.transform(code, { loader: "ts", format: "esm", sourcefile: id });
    return { code: stripped, map: null };
  },
});

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "module-kit-bundlers-"));
  await init;
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const outputDir = async (name: string): Promise<string> => mkdtemp(join(scratch, `${name}-`));

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  warnOnce: () => {},
  error: () => {},
  clearScreen: () => {},
  hasErrorLogged: () => false,
  hasWarned: false,
};

interface HmrSocket {
  /** The next full reload the server asks of its pages. */
  nextReload(): Promise<void>;
  /** The next error the server shows in its pages' overlay. */
  nextOverlay(): Promise<{ message: string }>;
  /** How many full reloads the server has asked for. */
  reloads(): number;
  close(): void;
}

// A dev server's HMR socket, as a page connects to it.
const hmrSocket = async (server: ViteDevServer): Promise<HmrSocket> => {
  const { port } = server.httpServer!.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${server.config.webSocketToken}`, "vite-hmr");
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let reloads = 0;
  socket.addEventListener("message", ({ data }: MessageEvent) => {
    if ((JSON.parse(String(data)) as { type: string }).type === "full-reload") reloads++;
  });

  const next = <T>(type: string): Promise<T> =>
    new Promise((resolve) => {
      const listener = ({ data }: MessageEvent) => {
        const payload = JSON.parse(String(data)) as { type: string; err?: unknown };
        if (payload.type !== type) return;

        socket.removeEventListener("message", listener);
        resolve(payload.err as T);
      };
      socket.addEventListener("message", listener);
    });

  return {
    nextReload: () => next("full-reload"),
    nextOverlay: () => next("error"),
    reloads: () => reloads,
    close: () => socket.close(),
  };
};

// Replaced whole, so that a watcher never sees a half-written file, and not
// within the watcher's 50 ms of its last change to the file, which it would
// drop as a repeat of that change.
const replace = async (path: string, text: string): Promise<void> => {
  await sleep(100);
  await writeFile(`${path}.new`, text);
  await rename(`${path}.new`, path);
};

// Every file under a directory, by its path relative to it.
const listed = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .sort();

type Webpackish = (options: object) => {
  run(
    callback: (error: Error | null, stats?: { hasErrors(): boolean; toString(options: object): string }) => void,
  ): void;
};

// webpack and Rspack report a refusal in their stats, not as a thrown error.
const runCompiler = (create: Webpackish, options: object): Promise<void> =>
  new Promise((resolve, reject) => {
    create(options).run((error, stats) => {
      if (error !== null) reject(error);
      else if (stats?.hasErrors() === true) reject(new Error(stats.toString({ all: false, errors: true })));
      else resolve();
    });
  });

const webpackOptions = (entry: string, out: string, maps: boolean, typescriptRule: object) => ({
  mode: "production",
  ...(maps ? { devtool: "source-map" } : {}),
  context: here,
  entry,
  module: { rules: [typescriptRule] },
  output: { path: out },
  infrastructureLogging: { level: "none" },
  stats: "none",
});

// Each bundler's build of `entry` into `out`, with the plugin added, and
// with source maps when `maps` is set.
const bundlers: Record<string, (entry: string, out: string, maps?: boolean) => Promise<void>> = {
  vite: async (entry, out, maps = false) => {
    await viteBuild({
      configFile: false,
      root: here,
      cacheDir: join(out, ".vite-cache"),
      logLevel: "silent",
      build: { outDir: out, emptyOutDir: false, sourcemap: maps },
      plugins: [vitePlugin({ entry })],
    });
    await rm(join(out, ".vite-cache"), { recursive: true, force: true });
  },
  rollup: async (entry, out, maps = false) => {
    const bundle = await rollup({
      input: entry,
      onwarn: () => {},
      plugins: [nodeResolve(), typescript(), terser(), rollupPlugin()],
    });
    await bundle.write({ dir: out, sourcemap: maps });
    await bundle.close();
  },
  rolldown: async (entry, out, maps = false) => {
    const bundle = await rolldown({ input: entry, logLevel: "silent", plugins: [rolldownPlugin()] });
    await bundle.write({ dir: out, sourcemap: maps });
    await bundle.close();
  },
  esbuild: async (entry, out, maps = false) => {
    await esbuild.build({
      absWorkingDir: here,
      entryPoints: [entry],
      outdir: out,
      sourcemap: maps,
      logLevel: "silent",
      plugins: [esbuildPlugin()],
    });
  },
  webpack: (entry, out, maps = false) =>
    runCompiler(webpack as unknown as Webpackish, {
      ...webpackOptions(entry, out, maps, { test: /\.ts$/, loader: typescriptLoader }),
      plugins: [webpackPlugin()],
    }),
  rspack: (entry, out, maps = false) =>
    runCompiler(rspack as unknown as Webpackish, {
      ...webpackOptions(entry, out, maps, {
        test: /\.ts$/,
        loader: "builtin:swc-loader",
        options: { jsc: { parser: { syntax: "typescript" } } },
        type: "javascript/auto",
      }),
      plugins: [rspackPlugin()],
    }),
};

// The hash in a script's name and the version, and the script's size, differ
// with the bundler; the rest of a manifest doesn't.
const comparable = (manifest: string): unknown => {
  const parsed = JSON.parse(manifest) as { version: string; module: { url: string; size: number } };
  return {
    ...parsed,
    version: parsed.version.replace(/\+js\.[0-9a-f]{16}$/, "+js.<hash>"),
    module: { ...parsed.module, url: parsed.module.url.replace(/[0-9a-f]{16}/, "<hash>"), size: 0 },
  };
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

// The command line's build of a module, from esbuild's bundle of it.
const commandLine = async (entry: string): Promise<{ manifest: string; settings: string }> => {
  const out = await outputDir("cli");
  const script = join(out, "bundled.js");
  await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", minify: true, outfile: script });
  await promisify(execFile)(process.execPath, [cli, "build", script, "--out", join(out, "module")]);

  return {
    manifest: await readFile(join(out, "module/manifest.json"), "utf8"),
    settings: await readFile(join(out, "module/settings.json"), "utf8"),
  };
};

let reference: { manifest: string; settings: string };
let references: Record<keyof typeof modules, { manifest: string; settings: string }>;

beforeAll(async () => {
  reference = await commandLine(fixture);
  references = { "bundled-fixture": reference, "pinyin-tones": await commandLine(pinyinTones) };
});

describe("the plugin", () => {
  const sizes: Record<string, number> = {};

  afterAll(() => {
    console.log(
      `Minified script sizes: ${Object.entries(sizes)
        .map(([bundler, size]) => `${bundler} ${size}`)
        .join(", ")}`,
    );
  });

  describe.each(Object.keys(bundlers))("in %s", (bundler) => {
    test.each(Object.keys(modules) as (keyof typeof modules)[])(
      "builds the %s module as the command line does, from one script that imports nothing",
      async (name) => {
        const { entry, version: declared } = modules[name];
        const directory = `ibus-module/${name}`;
        const out = await outputDir(bundler);
        await bundlers[bundler]!(entry, out);

        const files = await listed(out);
        const script = files.find((file) => new RegExp(`^${directory}/module\\.[0-9a-f]{16}\\.js$`).test(file));
        expect(files.filter((file) => !file.endsWith(".map") && !file.endsWith(".LICENSE.txt"))).toEqual(
          [`${directory}/manifest.json`, script, `${directory}/settings.json`].sort(),
        );

        const manifest = await readFile(join(out, directory, "manifest.json"), "utf8");
        const settings = await readFile(join(out, directory, "settings.json"), "utf8");
        expect(comparable(manifest)).toEqual(comparable(references[name].manifest));
        expect(settings).toBe(references[name].settings);

        const bytes = await readFile(join(out, script!));
        const { module, version } = JSON.parse(manifest) as { version: string; module: { url: string; size: number } };
        expect(module).toEqual({ url: `./module.${sha256(bytes)}.js`, size: bytes.length });
        expect(version).toBe(`${declared}+js.${sha256(Buffer.concat([bytes, Buffer.from(settings)]))}`);

        const [imports] = parse(bytes.toString("utf8"));
        expect(imports).toEqual([]);

        sizes[name === "bundled-fixture" ? bundler : `${bundler} (${name})`] = bytes.length;
      },
    );

    test("writes the bundler's source map beside the script, named for it and leading to the sources", async () => {
      const out = await outputDir(`${bundler}-maps`);
      await bundlers[bundler]!(fixture, out, true);

      const files = (await listed(out)).filter((file) => !file.endsWith(".LICENSE.txt"));
      const script = files.find((file) => /^ibus-module\/bundled-fixture\/module\.[0-9a-f]{16}\.js$/.test(file))!;
      expect(files).toEqual(
        [`${moduleDir}/manifest.json`, script, `${script}.map`, `${moduleDir}/settings.json`].sort(),
      );

      // The script's name hashes its code and the bundler's map, not the
      // comment naming the written one.
      const name = script.slice(moduleDir.length + 1);
      const text = await readFile(join(out, script), "utf8");
      const code = text.slice(0, text.lastIndexOf("\n//# sourceMappingURL="));
      expect(text.slice(code.length)).toBe(`\n//# sourceMappingURL=${name}.map\n`);
      expect(name).toMatch(/^module\.[0-9a-f]{16}\.js$/);
      expect(name).not.toBe(`module.${sha256(Buffer.from(code))}.js`);

      const map = JSON.parse(await readFile(join(out, `${script}.map`), "utf8")) as {
        file: string;
        sourceRoot?: string;
        sources: string[];
      };
      expect(map.file).toBe(name);
      const local = map.sources
        .filter((source) => !/^[a-z]+:/.test(source))
        .map((source) => resolve(out, moduleDir, map.sourceRoot ?? "", source));
      if (local.length > 0) expect(local).toContain(fixture);
      for (const source of local) await expect(access(source), source).resolves.toBeUndefined();

      const again = await outputDir(`${bundler}-maps-again`);
      await bundlers[bundler]!(fixture, again, true);
      expect(await listed(again)).toContain(script);
    });

    test("fails the build with the refusal's message", async () => {
      const out = await outputDir(`${bundler}-refused`);
      await expect(bundlers[bundler]!(refused, out)).rejects.toThrow(/ModuleRefused: /);
      expect((await listed(out)).filter((file) => file.includes("ibus-module"))).toEqual([]);
    });
  });

  test("replaces esbuild's entry in its output files when it writes none", async () => {
    const out = await outputDir("esbuild-unwritten");
    const result = await esbuild.build({
      absWorkingDir: here,
      entryPoints: [fixture],
      outdir: out,
      write: false,
      logLevel: "silent",
      plugins: [esbuildPlugin()],
    });

    expect(await listed(out)).toEqual([]);
    expect(result.outputFiles.map(({ path }) => relative(out, path)).sort()).toEqual([
      `${moduleDir}/manifest.json`,
      expect.stringMatching(/^ibus-module\/bundled-fixture\/module\.[0-9a-f]{16}\.js$/),
      `${moduleDir}/settings.json`,
    ]);

    const manifest = result.outputFiles.find(({ path }) => path.endsWith("manifest.json"))!;
    expect(comparable(manifest.text)).toEqual(comparable(reference.manifest));
  });

  test("puts the files where outDir says, without minifying when asked not to", async () => {
    const out = await outputDir("rolldown-options");
    const bundle = await rolldown({
      input: fixture,
      logLevel: "silent",
      plugins: [rolldownPlugin({ outDir: "modules/fixture", minify: false })],
    });
    await bundle.write({ dir: out });
    await bundle.close();

    const files = await listed(out);
    expect(files.filter((file) => file.startsWith("modules/fixture/"))).toHaveLength(3);
    const script = files.find((file) => file.endsWith(".js"))!;
    expect((await readFile(join(out, script))).length).toBeGreaterThan(sizes["rolldown"] ?? 0);
  });

  test("keeps the application's own minifier settings in Rolldown", async () => {
    const out = await outputDir("rolldown-dce-only");
    const bundle = await rolldown({ input: fixture, logLevel: "silent", plugins: [rolldownPlugin()] });
    await bundle.write({ dir: out, minify: "dce-only" });
    await bundle.close();

    const script = (await listed(out)).find((file) => file.endsWith(".js"))!;
    expect((await readFile(join(out, script))).length).toBeGreaterThan(sizes["rolldown"] ?? 0);
  });

  test("fails a Rollup build asked to minify, which Rollup can't", async () => {
    const minifying = rollupPlugin as (options: { minify: boolean }) => RollupPlugin;
    const bundle = await rollup({
      input: fixture,
      onwarn: () => {},
      plugins: [nodeResolve(), minifying({ minify: true })],
    });
    await expect(bundle.generate({})).rejects.toThrow(/no minifier of its own/);
    await bundle.close();
  });

  test("warns of each output setting it replaces", async () => {
    const rolldownLogs: string[] = [];
    const bundle = await rolldown({
      input: fixture,
      onLog: (level, log) => void (level === "warn" && rolldownLogs.push(log.message)),
      plugins: [rolldownPlugin()],
    });
    await bundle.write({ dir: await outputDir("rolldown-conflicts"), format: "cjs" });
    await bundle.close();
    expect(rolldownLogs).toContainEqual(expect.stringContaining("ibus-web-module replaces output.format"));

    const esbuilt = await esbuild.build({
      absWorkingDir: here,
      entryPoints: [fixture],
      outdir: await outputDir("esbuild-conflicts"),
      splitting: true,
      format: "esm",
      logLevel: "silent",
      plugins: [esbuildPlugin()],
    });
    expect(esbuilt.warnings.map(({ text }) => text)).toContainEqual(
      expect.stringContaining("ibus-web-module replaces splitting"),
    );

    const stats = await new Promise<{ toJson(): { warnings?: { message: string }[] } }>((resolve, reject) => {
      webpack({
        ...webpackOptions(fixture, join(scratch, "webpack-conflicts"), false, {
          test: /\.ts$/,
          loader: typescriptLoader,
        }),
        optimization: { splitChunks: { chunks: "all" } },
        plugins: [webpackPlugin()],
      } as webpack.Configuration).run((error, result) => (error === null ? resolve(result!) : reject(error)));
    });
    expect(stats.toJson().warnings?.map(({ message }) => message)).toContainEqual(
      expect.stringContaining("ibus-web-module replaces optimization.splitChunks"),
    );
  });

  test("refuses a build that emits files besides the script", async () => {
    const emitter = {
      name: "emitter",
      buildStart() {
        this.emitFile({ type: "asset", fileName: "extra.txt", source: "" });
      },
    } satisfies RollupPlugin;

    const bundle = await rolldown({ input: fixture, logLevel: "silent", plugins: [emitter, rolldownPlugin()] });
    await expect(bundle.generate({})).rejects.toThrow(/ModuleHasAssets: the build emits extra\.txt besides the script/);
    await bundle.close();

    await expect(
      viteBuild({
        configFile: false,
        root: here,
        cacheDir: await outputDir("vite-assets-cache"),
        logLevel: "silent",
        build: { outDir: await outputDir("vite-assets") },
        worker: { plugins: () => [emitter] },
        plugins: [vitePlugin({ entry: fixture })],
      }),
    ).rejects.toThrow(/ModuleHasAssets: the build emits extra\.txt besides the script/);
  });

  test("refuses a build that emits files besides the script in esbuild, webpack and Rspack", async () => {
    const asset = join(here, "fixture/with-asset.js");
    const refusal = /ModuleHasAssets: the build emits \S+\.txt besides the script/;

    await expect(
      esbuild.build({
        absWorkingDir: here,
        entryPoints: [asset],
        outdir: await outputDir("esbuild-assets"),
        loader: { ".txt": "file" },
        logLevel: "silent",
        plugins: [esbuildPlugin()],
      }),
    ).rejects.toThrow(refusal);

    const rule = { test: /\.txt$/, type: "asset/resource" };
    await expect(
      runCompiler(webpack as unknown as Webpackish, {
        ...webpackOptions(asset, await outputDir("webpack-assets"), false, rule),
        plugins: [webpackPlugin()],
      }),
    ).rejects.toThrow(refusal);
    await expect(
      runCompiler(rspack as unknown as Webpackish, {
        ...webpackOptions(asset, await outputDir("rspack-assets"), false, rule),
        plugins: [rspackPlugin()],
      }),
    ).rejects.toThrow(refusal);
  });

  test("moves the extracted licence comments beside the module", async () => {
    for (const bundler of ["webpack", "rspack"]) {
      const out = await outputDir(`${bundler}-licenses`);
      await bundlers[bundler]!(join(here, "fixture/licensed.js"), out);

      const files = await listed(out);
      const licences = files.filter((file) => file.endsWith(".LICENSE.txt"));
      if (bundler === "webpack") expect(licences).not.toEqual([]);
      for (const licence of licences) expect(licence.startsWith(`${moduleDir}/`), licence).toBe(true);

      const script = files.find((file) => /\/module\.[0-9a-f]{16}\.js$/.test(file))!;
      const named = /please see (\S+\.LICENSE\.txt)/.exec(await readFile(join(out, script), "utf8"))?.[1];
      if (named !== undefined) expect(files, bundler).toContain(`${moduleDir}/${named}`);
    }
  });

  test("keeps a hidden source map off the page but writes it by name", async () => {
    const rolldownOut = await outputDir("rolldown-hidden");
    const bundle = await rolldown({ input: fixture, logLevel: "silent", plugins: [rolldownPlugin()] });
    await bundle.write({ dir: rolldownOut, sourcemap: "hidden" });
    await bundle.close();

    const webpackOut = await outputDir("webpack-hidden");
    await runCompiler(webpack as unknown as Webpackish, {
      ...webpackOptions(fixture, webpackOut, false, { test: /\.ts$/, loader: typescriptLoader }),
      devtool: "hidden-source-map",
      plugins: [webpackPlugin()],
    });

    for (const out of [rolldownOut, webpackOut]) {
      const files = (await listed(out)).filter((file) => !file.endsWith(".LICENSE.txt"));
      const script = files.find((file) => /\/module\.[0-9a-f]{16}\.js$/.test(file))!;
      expect(files).toContain(`${script}.map`);
      expect(await readFile(join(out, script), "utf8")).not.toContain("sourceMappingURL");
    }
  });

  test("refuses an outDir outside the bundler's output", async () => {
    const out = await outputDir("esbuild-outside");
    await expect(
      esbuild.build({
        absWorkingDir: here,
        entryPoints: [fixture],
        outdir: out,
        logLevel: "silent",
        plugins: [esbuildPlugin({ outDir: "../elsewhere" })],
      }),
    ).rejects.toThrow(/OutDirRefused: /);
  });

  test("refuses a build of more than one entry", async () => {
    const out = await outputDir("esbuild-two");
    await expect(
      esbuild.build({
        absWorkingDir: here,
        entryPoints: [fixture, refused],
        outdir: join(out, "dist"),
        logLevel: "silent",
        plugins: [esbuildPlugin()],
      }),
    ).rejects.toThrow(/NotOneFile: /);
  });
});

describe("in Vite's dev server", () => {
  let built: { manifest: string; settings: string; size: number };
  let directory: string;
  let entry: string;
  let source: string;
  let server: ViteDevServer;
  let origin: string;
  let socket: HmrSocket;

  const errors: string[] = [];
  const errorListeners = new Set<() => void>();

  const logger: Logger = {
    info: () => {},
    warn: () => {},
    warnOnce: () => {},
    error: (message) => {
      errors.push(message);
      for (const listener of errorListeners) listener();
      errorListeners.clear();
    },
    clearScreen: () => {},
    hasErrorLogged: () => false,
    hasWarned: false,
  };

  const nextError = (): Promise<string> => new Promise((resolve) => errorListeners.add(() => resolve(errors.at(-1)!)));

  const nextReload = (): Promise<void> => socket.nextReload();

  const edit = (text: string): Promise<void> => replace(entry, text);

  const served = async (name: string): Promise<Response> => fetch(`${origin}/${moduleDir}/${name}`);

  const manifestServed = async (): Promise<{ version: string; module: { url: string; size: number } }> => {
    const response = await served("manifest.json");
    expect(response.status).toBe(200);
    return (await response.json()) as { version: string; module: { url: string; size: number } };
  };

  // The source sits outside the check's tree, which a Nix build can't write
  // to, and resolves the kit and Effect through a link to its packages.
  const sourceDirectory = async (name: string, text: string): Promise<string> => {
    const created = await outputDir(name);
    await symlink(join(here, "node_modules"), join(created, "node_modules"));
    await writeFile(join(created, "module.js"), text);
    return created;
  };

  const devServer = async (root: string): Promise<ViteDevServer> => {
    const started = await createServer({
      configFile: false,
      root,
      cacheDir: join(root, ".vite-cache"),
      customLogger: logger,
      server: { host: "127.0.0.1", port: 0 },
      plugins: [vitePlugin({ entry: "module.js" })],
    });
    await started.listen();
    return started;
  };

  beforeAll(async () => {
    source = await readFile(fixture, "utf8");
    directory = await sourceDirectory("vite-dev", source);
    entry = join(directory, "module.js");

    const out = await outputDir("vite-reference");
    await bundlers["vite"]!(entry, out);
    const manifest = await readFile(join(out, moduleDir, "manifest.json"), "utf8");
    built = {
      manifest,
      settings: await readFile(join(out, moduleDir, "settings.json"), "utf8"),
      size: (JSON.parse(manifest) as { module: { size: number } }).module.size,
    };

    server = await devServer(directory);
    origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;

    socket = await hmrSocket(server);
  });

  afterAll(async () => {
    socket.close();
    await server.close();
  });

  test("serves the files Vite's build writes, its script unminified", async () => {
    const manifest = await served("manifest.json");
    expect(manifest.headers.get("content-type")).toMatch(/^application\/json/);
    const text = await manifest.text();
    expect(comparable(text)).toEqual(comparable(built.manifest));

    const settings = await served("settings.json");
    expect(settings.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await settings.text()).toBe(built.settings);

    const { module, version } = JSON.parse(text) as { version: string; module: { url: string; size: number } };
    const script = await served(module.url.slice(2));
    expect(script.headers.get("content-type")).toMatch(/^text\/javascript/);
    const bytes = new Uint8Array(await script.arrayBuffer());
    const name = module.url.slice(2);
    const comment = Buffer.from(`\n//# sourceMappingURL=${name}.map\n`);
    const code = bytes.subarray(0, bytes.length - comment.length);
    expect(Buffer.from(bytes.subarray(code.length))).toEqual(comment);
    expect(module).toEqual({ url: expect.stringMatching(/^\.\/module\.[0-9a-f]{16}\.js$/), size: bytes.length });
    expect(version).toBe(`1.0.0+js.${sha256(Buffer.concat([code, Buffer.from(built.settings)]))}`);
    expect(bytes.length).toBeGreaterThan(built.size);

    const [imports] = parse(new TextDecoder().decode(bytes));
    expect(imports).toEqual([]);

    // The map is served beside the script, its sources the files the server
    // serves from its root.
    const map = await served(`${name}.map`);
    expect(map.headers.get("content-type")).toMatch(/^application\/json/);
    const { file, sources } = (await map.json()) as { file: string; sources: string[] };
    expect(file).toBe(name);
    expect(sources.map((source) => new URL(source, `${origin}/${moduleDir}/`).href)).toContain(`${origin}/module.js`);
  });

  test("rebuilds on an edit to its source and reloads the page", async () => {
    const before = await manifestServed();

    const reloaded = nextReload();
    await edit(source.replace('"delta"', '"echo"'));
    await reloaded;

    const after = await manifestServed();
    expect(after.version).not.toBe(before.version);
    expect((await served(after.module.url.slice(2))).status).toBe(200);
  });

  test("keeps the last good build through a broken edit, then recovers", async () => {
    const good = await manifestServed();

    const threw = nextError();
    const shown = socket.nextOverlay();
    await edit(`${source}\nthrow new Error("broken edit");\n`);
    expect(await threw).toMatch(/ScriptThrew: .*broken edit/);
    expect((await shown).message).toMatch(/^\[ibus-web-module\] ScriptThrew: .*broken edit/);
    expect((await manifestServed()).version).toBe(good.version);

    const unbundled = nextError();
    await edit(`${source}\nexport const = ;\n`);
    expect(await unbundled).toMatch(/BundleFailed: /);
    expect((await manifestServed()).version).toBe(good.version);

    const reloaded = nextReload();
    await edit(source.replace('"delta"', '"foxtrot"'));
    await reloaded;
    expect((await manifestServed()).version).not.toBe(good.version);
  });

  test("rebuilds a first build that failed once the file it couldn't find is created", async () => {
    const root = await sourceDirectory("vite-dev-missing", `import "./extra.js";\n${source}`);
    const missingServer = await devServer(root);
    const missingSocket = await hmrSocket(missingServer);
    const address = missingServer.httpServer!.address() as AddressInfo;
    const manifest = () => fetch(`http://127.0.0.1:${address.port}/${moduleDir}/manifest.json`);

    try {
      const logged = nextError();
      const failed = await manifest();
      expect(failed.status).toBe(500);
      expect(await failed.text()).toMatch(/^BundleFailed: .*extra\.js/s);
      await logged;

      const reloaded = missingSocket.nextReload();
      await replace(join(root, "extra.js"), "// Bundled with the module, and empty.\n");
      await reloaded;
      expect((await manifest()).status).toBe(200);
    } finally {
      missingSocket.close();
      await missingServer.close();
    }
  });

  test("answers 404 for a file under its directory that the build doesn't have", async () => {
    await manifestServed();
    expect((await served("module.0000000000000000.js")).status).toBe(404);
  });

  test("passes on a file under the claimed directory that isn't the module's", async () => {
    const root = await sourceDirectory("vite-dev-public", source);
    await mkdir(join(root, "public/ibus-module"), { recursive: true });
    await writeFile(join(root, "public/ibus-module/other.txt"), "not the module's\n");

    const publicServer = await devServer(root);
    const address = publicServer.httpServer!.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/ibus-module/other.txt`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("not the module's\n");
    } finally {
      await publicServer.close();
    }
  });

  test("answers with the refusal while it has no good build", async () => {
    const refusedServer = await devServer(await sourceDirectory("vite-dev-refused", await readFile(refused, "utf8")));
    const address = refusedServer.httpServer!.address() as AddressInfo;

    try {
      const logged = nextError();
      const response = await fetch(`http://127.0.0.1:${address.port}/ibus-module/anything/manifest.json`);
      expect(response.status).toBe(500);
      expect(await response.text()).toMatch(/^ModuleRefused: /);
      expect(await logged).toMatch(/ModuleRefused: /);
    } finally {
      await refusedServer.close();
    }
  });

  test("doesn't keep each build's script in the server's heap", async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;

    const rebuild = async (word: string): Promise<void> => {
      const reloaded = nextReload();
      await edit(source.replace('"delta"', JSON.stringify(word)));
      await reloaded;
      await manifestServed();
    };

    await manifestServed();
    await rebuild("warm");
    gc();
    const before = process.memoryUsage().heapUsed;

    for (let index = 0; index < 20; index++) await rebuild(`word${index}`);
    gc();
    const grown = process.memoryUsage().heapUsed - before;

    console.log(`Heap growth over 20 rebuilds: ${(grown / 2 ** 20).toFixed(1)} MiB`);
    expect(grown).toBeLessThan(24 * 2 ** 20);
  });
});

describe("imported with ?ibus-module", () => {
  const app = join(here, "fixture/app");
  const base = "/app/";
  const alias = { "@fixture/aliased-engine": join(here, "fixture/aliased-engine.js") };

  // The application's build: a page whose script imports the fixture and the
  // aliased module, both found where the check reads them.
  const appBuild = async (out: string, input?: string, withAlias = true): Promise<void> => {
    await viteBuild({
      configFile: false,
      root: app,
      base,
      cacheDir: join(out, ".vite-cache"),
      logLevel: "silent",
      resolve: { alias: withAlias ? alias : {} },
      build: {
        outDir: out,
        emptyOutDir: false,
        modulePreload: { polyfill: false },
        ...(input === undefined ? {} : { rolldownOptions: { input } }),
      },
      plugins: [vitePlugin()],
    });
    await rm(join(out, ".vite-cache"), { recursive: true, force: true });
  };

  // The application's script, which only assigns, run for what it assigns.
  const imported = async (out: string, files: readonly string[]): Promise<Record<string, string>> => {
    const script = files.find((file) => /^assets\/index-[\w-]+\.js$/.test(file))!;
    const context: { modules?: Record<string, string> } = {};
    runInNewContext(await readFile(join(out, script), "utf8"), context);
    return context.modules!;
  };

  describe("in vite build", () => {
    let out: string;
    let files: string[];

    beforeAll(async () => {
      out = await outputDir("vite-import");
      await appBuild(out);
      files = await listed(out);
    });

    test("emits each module under the assets directory, as the command line builds it", async () => {
      const directory = "assets/bundled-fixture";
      const script = files.find((file) => /^assets\/bundled-fixture\/module\.[0-9a-f]{16}\.js$/.test(file));
      expect(files.filter((file) => file.startsWith(`${directory}/`))).toEqual(
        [`${directory}/manifest.json`, script, `${directory}/settings.json`].sort(),
      );

      const manifest = await readFile(join(out, directory, "manifest.json"), "utf8");
      const settings = await readFile(join(out, directory, "settings.json"), "utf8");
      expect(comparable(manifest)).toEqual(comparable(reference.manifest));
      expect(settings).toBe(reference.settings);

      const bytes = await readFile(join(out, script!));
      const { module } = JSON.parse(manifest) as { module: { url: string; size: number } };
      expect(module).toEqual({ url: `./module.${sha256(bytes)}.js`, size: bytes.length });

      const [imports] = parse(bytes.toString("utf8"));
      expect(imports).toEqual([]);
    });

    test("gives each import its manifest's URL under the application's base", async () => {
      expect(await imported(out, files)).toEqual({
        fixture: `${base}assets/bundled-fixture/manifest.json`,
        aliased: `${base}assets/aliased-fixture/manifest.json`,
      });
    });

    test("resolves the application's aliases inside the module", async () => {
      const manifest = await readFile(join(out, "assets/aliased-fixture/manifest.json"), "utf8");
      expect(manifest).toContain('"displayName": "Reached through an alias"');

      const script = files.find((file) => /^assets\/aliased-fixture\/module\.[0-9a-f]{16}\.js$/.test(file))!;
      const [imports] = parse(await readFile(join(out, script), "utf8"));
      expect(imports).toEqual([]);

      await expect(appBuild(await outputDir("vite-import-unaliased"), undefined, false)).rejects.toThrow(
        /BundleFailed: .*@fixture\/aliased-engine/s,
      );
    });

    test("builds an application whose input is a script as an application", async () => {
      const scriptOut = await outputDir("vite-import-script");
      await appBuild(scriptOut, join(app, "main.ts"));

      const scriptFiles = await listed(scriptOut);
      expect(scriptFiles).toContain("assets/bundled-fixture/manifest.json");
      expect(scriptFiles.filter((file) => /^assets\/main-[\w-]+\.js$/.test(file))).toHaveLength(1);
    });

    test("fails the build for two entries giving modules of one name", async () => {
      await expect(appBuild(await outputDir("vite-import-twins"), join(app, "twins.html"))).rejects.toThrow(
        /DuplicateModuleName: \.\.\/module\.js and \.\.\/twin\.js both build a module named "bundled-fixture"/,
      );
    });
  });

  // A page importing a copy of the fixture module, outside the check's tree
  // so that the module can be edited.
  const importingApp = async (name: string): Promise<{ directory: string; source: string }> => {
    const directory = await outputDir(name);
    const source = await readFile(fixture, "utf8");
    await symlink(join(here, "node_modules"), join(directory, "node_modules"));
    await writeFile(join(directory, "module.js"), source);
    await writeFile(join(directory, "main.js"), 'import url from "./module.js?ibus-module";\nglobalThis.url = url;\n');
    await writeFile(join(directory, "index.html"), '<script type="module" src="./main.js"></script>\n');
    return { directory, source };
  };

  test("passes the module's build warnings to the application's logger", async () => {
    const { directory, source } = await importingApp("vite-warnings");
    await writeFile(join(directory, "module.js"), `${source}\nexport const evaluate = (code) => eval(code);\n`);

    const warnings: string[] = [];
    await viteBuild({
      configFile: false,
      root: directory,
      cacheDir: join(directory, ".vite-cache"),
      customLogger: { ...silentLogger, warn: (message) => void warnings.push(message) },
      build: { outDir: join(directory, "dist") },
      plugins: [vitePlugin({ entry: "module.js" })],
    });

    expect(warnings).toContainEqual(expect.stringMatching(/^\[ibus-web-module\] .*eval/s));
  });

  test("rebuilds the module in vite build --watch when its source changes", async () => {
    const { directory, source } = await importingApp("vite-import-watch");

    const out = join(directory, "dist");
    const manifest = join(out, "assets/bundled-fixture/manifest.json");
    const version = async (): Promise<string | undefined> =>
      readFile(manifest, "utf8").then(
        (text) => (JSON.parse(text) as { version: string }).version,
        () => undefined,
      );
    const changed = async (from: string | undefined, polls: number): Promise<string | undefined> => {
      for (let poll = 0; poll < polls; poll++) {
        const current = await version();
        if (current !== undefined && current !== from) return current;
        await sleep(100);
      }
      return undefined;
    };

    const watcher = (await viteBuild({
      configFile: false,
      root: directory,
      cacheDir: join(directory, ".vite-cache"),
      logLevel: "silent",
      build: { outDir: out, watch: {} },
      plugins: [vitePlugin()],
    })) as { on(event: "event", listener: (event: { code: string }) => void): void; close(): Promise<void> };

    // The watcher registers the files a build read once the build ends.
    let ended = 0;
    watcher.on("event", ({ code }) => {
      if (code === "END") ended++;
    });

    try {
      const first = await changed(undefined, 600);
      expect(first).toBeDefined();
      for (let poll = 0; ended === 0 && poll < 600; poll++) await sleep(100);

      // Edited again each second, should an edit still land before the
      // watcher has the file.
      let rebuilt: string | undefined;
      for (let edit = 0; rebuilt === undefined && edit < 60; edit++) {
        await replace(join(directory, "module.js"), source.replace('"delta"', JSON.stringify(`echo${edit}`)));
        rebuilt = await changed(first, 10);
      }
      expect(rebuilt).toBeDefined();
    } finally {
      await watcher.close();
    }
  });

  test("rebuilds an imported module in Vite's dev server when its source changes, and reloads the page", async () => {
    const { directory, source } = await importingApp("vite-import-dev-edit");
    const server = await createServer({
      configFile: false,
      root: directory,
      cacheDir: join(directory, ".vite-cache"),
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [vitePlugin()],
    });
    await server.listen();
    const socket = await hmrSocket(server);
    const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;

    try {
      const main = await (await fetch(`${origin}/main.js`)).text();
      const imported = await (await fetch(`${origin}${/from "([^"]*\?ibus-module)"/.exec(main)![1]!}`)).text();
      const url = JSON.parse(/export default ("[^"]*")/.exec(imported)![1]!) as string;
      const version = async () => ((await (await fetch(`${origin}${url}`)).json()) as { version: string }).version;
      const before = await version();

      const reloaded = socket.nextReload();
      await replace(join(directory, "module.js"), source.replace('"delta"', '"echo"'));
      await reloaded;
      expect(await version()).not.toBe(before);

      // One reload, once the module is rebuilt, and not one from Vite's own
      // update of the import as soon as the file changed.
      await sleep(500);
      expect(socket.reloads()).toBe(1);
    } finally {
      socket.close();
      await server.close();
    }
  });

  describe("in Vite's dev server", () => {
    let server: ViteDevServer;
    let origin: string;

    beforeAll(async () => {
      server = await createServer({
        configFile: false,
        root: app,
        base,
        cacheDir: await outputDir("vite-import-dev-cache"),
        logLevel: "silent",
        resolve: { alias },
        server: { host: "127.0.0.1", port: 0 },
        plugins: [vitePlugin()],
      });
      await server.listen();
      origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await server.close();
    });

    // What the page's script gets from its import of `specifier`, fetched as
    // the browser fetches it.
    const importedUrl = async (specifier: string): Promise<string> => {
      const main = await (await fetch(`${origin}${base}main.ts`)).text();
      const path = new RegExp(`from "([^"]*${specifier.replaceAll(".", "\\.")}\\?ibus-module)"`).exec(main)![1]!;
      const module = await (await fetch(`${origin}${path}`)).text();
      return JSON.parse(/export default ("[^"]*")/.exec(module)![1]!) as string;
    };

    test("serves the module at the URL its import gives", async () => {
      const url = await importedUrl("module.js");
      expect(url).toBe(`${base}assets/bundled-fixture/manifest.json`);

      const manifest = await fetch(`${origin}${url}`);
      expect(manifest.status).toBe(200);
      const text = await manifest.text();
      expect(comparable(text)).toEqual(comparable(reference.manifest));

      const settings = await fetch(`${origin}${base}assets/bundled-fixture/settings.json`);
      expect(await settings.text()).toBe(reference.settings);

      const { module } = JSON.parse(text) as { module: { url: string; size: number } };
      const script = await fetch(new URL(module.url, `${origin}${url}`));
      expect(script.status).toBe(200);
      expect((await script.arrayBuffer()).byteLength).toBe(module.size);
    });

    test("serves each imported module at its own URL", async () => {
      const url = await importedUrl("aliased.js");
      expect(url).toBe(`${base}assets/aliased-fixture/manifest.json`);
      expect(await (await fetch(`${origin}${url}`)).text()).toContain('"displayName": "Reached through an alias"');
    });
  });
});
