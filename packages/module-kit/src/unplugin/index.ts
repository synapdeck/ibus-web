// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve } from "node:path";
import { createUnplugin, type UnpluginFactory, type UnpluginOptions } from "unplugin";
import { ModuleHasAssets, NotOneFile, outputInWorker, refusalMessage, type OutputFile } from "./files.ts";
import { vitePlugin } from "./vite-plugin.ts";

export { ModuleHasAssets, NotOneFile, OutDirRefused, type PluginRefusal } from "./files.ts";
export { BundleFailed, DuplicateModuleName } from "./vite-build.ts";

export interface IbusModuleOptions {
  /**
   * The directory, inside the bundler's output, that the module's files go to. Defaults to `ibus-module/<module
   * name>`. A module a Vite application imports with `?ibus-module` goes to `<assetsDir>/<module name>` instead.
   */
  readonly outDir?: string;
  /**
   * Whether the script is minified, with the bundler's own minifier. Defaults to true in Rolldown and esbuild, and in
   * Vite, webpack and Rspack to what the bundler does itself, which is to minify a production build. Rollup has no
   * minifier of its own.
   */
  readonly minify?: boolean;
}

/** The Vite plugin's options. */
export interface IbusModuleViteOptions extends IbusModuleOptions {
  /**
   * The module's entry, relative to Vite's `root`. Given, `vite build` is the module's own build and the dev server
   * serves the module under `outDir`. Unset, the plugin only builds the modules a `?ibus-module` import names.
   */
  readonly entry?: string;
}

/** The Rollup plugin's options: Rollup has no minifier of its own for the plugin to turn on or off. */
export type IbusModuleRollupOptions = Omit<IbusModuleOptions, "minify">;

const name = "ibus-web-module";

// Rollup's and Rolldown's bundle: what `generateBundle` is given,
// reduced to what the plugin reads.
type Bundle = Record<
  string,
  | {
      readonly type: "chunk";
      readonly code: string;
      readonly isEntry: boolean;
      readonly map: { toString(): string } | null;
      readonly sourcemapFileName?: string | null;
    }
  | { readonly type: "asset" }
>;

interface BundleContext {
  emitFile(file: { type: "asset"; fileName: string; source: Uint8Array }): string;
  error(message: string): never;
}

// The one entry chunk becomes the module's files, emitted in its place.
async function generateBundle(this: BundleContext, outDir: string | undefined, bundle: Bundle): Promise<void> {
  const chunks = Object.entries(bundle).flatMap(([fileName, output]) =>
    output.type === "chunk" ? [{ fileName, ...output }] : [],
  );
  const [entry] = chunks;
  if (chunks.length !== 1 || entry === undefined || !entry.isEntry) {
    this.error(notOneFile(chunks.map(({ fileName }) => fileName)));
  }

  // The map is the chunk's own, which an inlined one is too, and its file,
  // if the bundler writes one, goes with the entry.
  const mapFileName = entry.sourcemapFileName ?? `${entry.fileName}.map`;
  const assets = Object.entries(bundle).flatMap(([fileName, output]) =>
    output.type === "asset" && fileName !== mapFileName ? [fileName] : [],
  );
  if (assets.length > 0) this.error(refusalMessage(new ModuleHasAssets({ files: assets.sort() })));

  const result = await outputInWorker({
    script: entry.code,
    sourceMap: entry.map?.toString(),
    from: posix.dirname(entry.fileName),
    outDir,
  });
  if ("error" in result) this.error(result.error);

  delete bundle[entry.fileName];
  if (bundle[mapFileName]?.type === "asset") delete bundle[mapFileName];
  for (const { fileName, bytes } of result.files) this.emitFile({ type: "asset", fileName, source: bytes });
}

const notOneFile = (files: readonly string[]): string => refusalMessage(new NotOneFile({ files }));

const esFormats = new Set(["es", "esm", "module"]);

// A setting the application gave that the plugin replaces: replaced rather
// than refused, since a framework may set it for every build it makes.
const overridden = (setting: string): string =>
  `${name} replaces ${setting}: a module is one ES module file, every import inlined and its exports kept`;

// In order, the manifest last, so that one on disk never names a file not yet
// written.
const writeFiles = async (directory: string, files: readonly OutputFile[]): Promise<void> => {
  for (const { fileName, bytes } of files) {
    const path = join(directory, fileName);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
};

/** The plugin's factory, for `createUnplugin` or a framework's own unplugin integration. */
export const unpluginFactory: UnpluginFactory<IbusModuleViteOptions | undefined, false> = (options = {}) => {
  const { outDir, minify, entry } = options;

  // esbuild's settings the plugin replaces, read before it does.
  let conflicts: readonly string[] = [];

  const plugin: UnpluginOptions = {
    name,

    rollup: {
      outputOptions(output) {
        if (minify === true) this.error("Rollup has no minifier of its own: add one, such as @rollup/plugin-terser");

        for (const setting of [
          ...(output.format === undefined || esFormats.has(output.format) ? [] : ["output.format"]),
          ...(output.inlineDynamicImports === false ? ["output.inlineDynamicImports"] : []),
        ]) {
          this.warn(overridden(setting));
        }
        return { ...output, format: "es", inlineDynamicImports: true };
      },
      generateBundle(_, bundle) {
        return generateBundle.call(this as BundleContext, outDir, bundle as Bundle);
      },
    },

    rolldown: {
      outputOptions(output) {
        for (const setting of [
          ...(output.format === undefined || esFormats.has(output.format) ? [] : ["output.format"]),
          ...(output.codeSplitting === undefined || output.codeSplitting === false ? [] : ["output.codeSplitting"]),
        ]) {
          this.warn(overridden(setting));
        }

        // The application's own minifier settings, as `"dce-only"`, when the
        // plugin's `minify` doesn't turn minifying off.
        const minified = minify ?? true;
        return {
          ...output,
          format: "es",
          codeSplitting: false,
          minify:
            minified && output.minify !== undefined && typeof output.minify !== "boolean" ? output.minify : minified,
        };
      },
      generateBundle(_, bundle) {
        return generateBundle.call(this as BundleContext, outDir, bundle as Bundle);
      },
    },

    vite: vitePlugin({ entry, outDir, minify }),

    esbuild: {
      config(build) {
        conflicts = [
          ...(build.bundle === false ? ["bundle"] : []),
          ...(build.format === undefined || build.format === "esm" ? [] : ["format"]),
          ...(build.splitting === true ? ["splitting"] : []),
        ];

        build.bundle = true;
        build.format = "esm";
        build.splitting = false;
        build.metafile = true;

        const minified = minify ?? true;
        if (!minified) {
          build.minify = false;
          build.minifyWhitespace = false;
          build.minifyIdentifiers = false;
          build.minifySyntax = false;
        } else if (
          build.minifyWhitespace === undefined &&
          build.minifyIdentifiers === undefined &&
          build.minifySyntax === undefined
        ) {
          build.minify = true;
        }
      },
      setup(build) {
        build.onEnd(async (result) => {
          const warnings = conflicts.map((setting) => ({ text: overridden(setting) }));
          if (result.errors.length > 0 || result.metafile === undefined) return { warnings };

          const workingDir = build.initialOptions.absWorkingDir ?? process.cwd();
          const entries = Object.entries(result.metafile.outputs).flatMap(([path, output]) =>
            output.entryPoint === undefined ? [] : [path],
          );
          const [entry] = entries;
          if (entries.length !== 1 || entry === undefined) {
            return { errors: [{ text: notOneFile(entries) }], warnings };
          }

          const entryPath = resolve(workingDir, entry);
          const { outdir, outfile } = build.initialOptions;
          const directory = resolve(workingDir, outdir ?? (outfile === undefined ? dirname(entry) : dirname(outfile)));

          // esbuild names an entry's map for it, and lists it among the
          // outputs when it writes one.
          const mapPath = `${entryPath}.map`;
          const hasMap = Object.keys(result.metafile.outputs).some((path) => resolve(workingDir, path) === mapPath);

          const assets = Object.keys(result.metafile.outputs).filter((path) => {
            const resolved = resolve(workingDir, path);
            return resolved !== entryPath && resolved !== mapPath;
          });
          if (assets.length > 0) {
            return { errors: [{ text: refusalMessage(new ModuleHasAssets({ files: assets.sort() })) }], warnings };
          }

          // With `write: false` the files are kept in the result, and replacing
          // the entry there is all that writing them would do.
          const kept = result.outputFiles?.filter(({ path }) => path === entryPath || (hasMap && path === mapPath));
          const read = async (path: string): Promise<Uint8Array> =>
            kept?.find((file) => file.path === path)?.contents ?? (await readFile(path));

          const built = await outputInWorker({
            script: await read(entryPath),
            sourceMap: hasMap ? await read(mapPath) : undefined,
            from: relative(directory, dirname(entryPath)).replaceAll("\\", "/"),
            outDir,
          });
          if ("error" in built) return { errors: [{ text: built.error }], warnings };

          if (result.outputFiles !== undefined) {
            result.outputFiles = [
              ...result.outputFiles.filter((file) => !kept!.includes(file)),
              ...built.files.map(({ fileName, bytes }) => outputFile(join(directory, fileName), bytes)),
            ];
          } else {
            await writeFiles(directory, built.files);
            await rm(entryPath);
            if (hasMap) await rm(mapPath);
          }
          return { warnings };
        });
      },
    },

    webpack(compiler) {
      webpackLike(compiler as unknown as WebpackLikeCompiler, { outDir, minify, outputModule: true });
    },

    rspack(compiler) {
      webpackLike(compiler as unknown as WebpackLikeCompiler, { outDir, minify, outputModule: false });
    },
  };

  return plugin;
};

// What esbuild keeps of a file with `write: false`.
const outputFile = (path: string, contents: Uint8Array) => ({
  path,
  contents,
  hash: "",
  get text() {
    return new TextDecoder().decode(contents);
  },
});

// The parts of webpack's and Rspack's compiler the plugin uses, which the two
// share.
interface WebpackLikeCompiler {
  readonly options: {
    experiments: { outputModule?: boolean | undefined };
    output: {
      module?: boolean | undefined;
      chunkFormat?: string | false | undefined;
      asyncChunks?: boolean | undefined;
      library?: unknown;
    };
    optimization: { minimize?: boolean | undefined; splitChunks?: unknown; runtimeChunk?: unknown };
  };
  readonly webpack: {
    readonly Compilation: { readonly PROCESS_ASSETS_STAGE_SUMMARIZE: number };
    readonly WebpackError: new (message: string) => Error;
    readonly sources: { readonly RawSource: new (source: Buffer) => unknown };
  };
  readonly hooks: {
    readonly thisCompilation: { tap(name: string, callback: (compilation: WebpackLikeCompilation) => void): void };
  };
}

interface WebpackLikeCompilation {
  readonly chunks: Iterable<{ readonly files: Iterable<string> }>;
  readonly entrypoints: { readonly size: number };
  readonly errors: Error[];
  readonly warnings: Error[];
  readonly hooks: {
    readonly processAssets: {
      tapPromise(options: { name: string; stage: number }, callback: () => Promise<void>): void;
    };
  };
  getAssets(): readonly { readonly name: string }[];
  getAsset(name: string):
    | {
        readonly source: { source(): string | Buffer };
        readonly info: { readonly related?: { readonly sourceMap?: string | readonly string[] } };
      }
    | undefined;
  deleteAsset(name: string): void;
  emitAsset(name: string, source: unknown, info: { minimized: boolean }): void;
}

const isScript = (file: string): boolean => /\.m?js$/.test(file);

const webpackLike = (
  compiler: WebpackLikeCompiler,
  { outDir, minify, outputModule }: { outDir: string | undefined; minify: boolean | undefined; outputModule: boolean },
): void => {
  const { options, webpack } = compiler;
  const { output, optimization } = options;

  // The compiler fills an unset `splitChunks` with an object of these two
  // keys, before its defaults.
  const splitChunks = optimization.splitChunks as
    | false
    | undefined
    | { readonly cacheGroups?: object; readonly [key: string]: unknown };
  const splits =
    typeof splitChunks === "object" &&
    (Object.keys(splitChunks).some((key) => key !== "defaultSizeTypes" && key !== "cacheGroups") ||
      Object.keys(splitChunks.cacheGroups ?? {}).length > 0);
  const library = output.library as { readonly type?: unknown } | undefined;

  const conflicts = [
    ...(output.module === false ? ["output.module"] : []),
    ...(output.chunkFormat === undefined || output.chunkFormat === "module" ? [] : ["output.chunkFormat"]),
    ...(library === undefined || library.type === "module" ? [] : ["output.library"]),
    ...(output.asyncChunks === true ? ["output.asyncChunks"] : []),
    ...(splits ? ["optimization.splitChunks"] : []),
    ...(optimization.runtimeChunk === undefined || optimization.runtimeChunk === false
      ? []
      : ["optimization.runtimeChunk"]),
  ];

  // Set before the compiler applies its defaults, which follow from these:
  // one chunk holding its runtime and every dynamic import, written as an ES
  // module whose exports are the entry's.
  if (outputModule) options.experiments.outputModule = true;
  options.output.module = true;
  options.output.chunkFormat = "module";
  options.output.library = { type: "module" };
  options.output.asyncChunks = false;
  options.optimization.splitChunks = false;
  options.optimization.runtimeChunk = false;
  if (minify !== undefined) options.optimization.minimize = minify;

  compiler.hooks.thisCompilation.tap(name, (compilation) => {
    for (const setting of conflicts) compilation.warnings.push(new webpack.WebpackError(overridden(setting)));

    // After minifying, so that the script hashed is the one served.
    compilation.hooks.processAssets.tapPromise(
      { name, stage: webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE },
      async () => {
        const scripts = [...compilation.chunks].flatMap((chunk) => [...chunk.files].filter(isScript));
        const [entry] = scripts;
        const asset = entry === undefined ? undefined : compilation.getAsset(entry);
        if (scripts.length !== 1 || compilation.entrypoints.size !== 1 || entry === undefined || asset === undefined) {
          compilation.errors.push(new webpack.WebpackError(notOneFile(scripts)));
          return;
        }

        // The devtool's map, written by now and named in the script's asset
        // info.
        const related = asset.info.related?.sourceMap;
        const [mapName] = typeof related === "string" ? [related] : (related ?? []);
        const map = mapName === undefined ? undefined : compilation.getAsset(mapName)?.source.source();

        // The minimizer's extracted comments are named in the script, so
        // they go beside it; any other file besides the map is refused.
        const licenses = compilation.getAssets().flatMap(({ name }) => (name.endsWith(".LICENSE.txt") ? [name] : []));
        const assets = compilation
          .getAssets()
          .flatMap(({ name }) => (name === entry || name === mapName || licenses.includes(name) ? [] : [name]));
        if (assets.length > 0) {
          compilation.errors.push(
            new webpack.WebpackError(refusalMessage(new ModuleHasAssets({ files: assets.sort() }))),
          );
          return;
        }

        const bytes = (source: string | Buffer): Uint8Array | string =>
          typeof source === "string" ? source : new Uint8Array(source);
        const built = await outputInWorker({
          script: bytes(asset.source.source()),
          sourceMap: map === undefined ? undefined : bytes(map),
          from: posix.dirname(entry),
          outDir,
        });
        if ("error" in built) {
          compilation.errors.push(new webpack.WebpackError(built.error));
          return;
        }

        // Read first: deleting the script deletes the assets related to it.
        const kept = licenses.flatMap((license) => {
          const source = compilation.getAsset(license)?.source.source();
          return source === undefined ? [] : [{ name: posix.basename(license), source }];
        });

        // Marked minimized, or a minimizer that also processes assets added
        // later would change the script after its hash names it.
        compilation.deleteAsset(entry);
        if (mapName !== undefined && compilation.getAsset(mapName) !== undefined) compilation.deleteAsset(mapName);
        for (const { fileName, bytes } of built.files) {
          compilation.emitAsset(fileName, new webpack.sources.RawSource(Buffer.from(bytes)), { minimized: true });
        }

        const directory = posix.dirname(built.files[0]!.fileName);
        for (const { name, source } of kept) {
          compilation.emitAsset(`${directory}/${name}`, new webpack.sources.RawSource(Buffer.from(source)), {
            minimized: true,
          });
        }
      },
    );
  });
};

/** The plugin, for each bundler unplugin supports. */
export const unplugin = /* #__PURE__ */ createUnplugin(unpluginFactory);

export default unplugin;
