// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { dirname, normalize, relative, resolve } from "node:path";
import { errorMessage } from "@ibus-web/protocol";
import { Data } from "effect";
import type { Logger, Plugin, PluginOption, ResolvedConfig, Rolldown } from "vite";
import { ModuleHasAssets, NotOneFile, outputInWorker, type OutputFile } from "./files.ts";

/** A module's build in Vite that the bundler itself failed. */
export class BundleFailed extends Data.TaggedError("BundleFailed")<{
  readonly reason: string;
  readonly message: string;
}> {
  constructor({ reason }: { readonly reason: string }) {
    super({ reason, message: `the module's entry doesn't bundle: ${reason}` });
  }
}

/** Two entries in one Vite application giving modules of the same name, whose files would share a directory. */
export class DuplicateModuleName extends Data.TaggedError("DuplicateModuleName")<{
  readonly name: string;
  readonly entries: readonly [string, string];
  readonly message: string;
}> {
  // In order, since which of the two builds first is a race.
  constructor({ name, entries }: { readonly name: string; readonly entries: readonly [string, string] }) {
    const [first, second] = [...entries].sort() as [string, string];
    super({
      name,
      entries: [first, second],
      message: `${first} and ${second} both build a module named ${JSON.stringify(name)}, but each module's name gives its files their directory`,
    });
  }
}

/** The query of an import that gives a module's manifest URL. */
export const moduleQuery = /[?&]ibus-module(?:&|$)/;

// An application's entry exports nothing, but a module's default export is
// what the host loads.
const moduleRolldownOptions = {
  preserveEntrySignatures: "strict",
  output: { format: "es", codeSplitting: false },
} as const;

/** How a module's build in Vite runs, whichever way the plugin was asked for it. */
export interface ViteModuleOptions {
  /** The application's `worker.plugins`, called for fresh instances on each build. */
  readonly workerPlugins: (() => PluginOption[]) | undefined;
  readonly minify: ResolvedConfig["build"]["minify"];
  readonly sourcemap: ResolvedConfig["build"]["sourcemap"];
  /** The directory the files' paths are relative to: the build's `outDir`, or the root the dev server serves. */
  readonly outputRoot: string;
  /** The directory the files go to, or, unset, a directory named for the module under `parent`. */
  readonly outDir: string | undefined;
  readonly parent: string;
}

/** A module built in Vite: its name and files, and the sources it bundled, which a change to rebuilds it. */
export interface ViteModule {
  readonly name: string;
  readonly files: readonly OutputFile[];
  readonly sources: readonly string[];
}

/** A module's build in Vite that failed, and the sources it read before failing, which a change to may fix. */
export interface ViteModuleFailure {
  readonly error: string;
  readonly sources: readonly string[];
}

const outDirOf = (config: ResolvedConfig): string => resolve(config.root, config.build.outDir);

// Virtual modules and dependencies don't change under an author's edits.
const isSource = (id: string): boolean => !id.includes("\0") && !id.includes("/node_modules/");

// Each file the build loads, whether or not the build then succeeds: a
// failed build has no chunk to list its modules.
const recorder = (read: Set<string>): Plugin => ({
  name: "ibus-web-module:sources",
  enforce: "pre",
  load(id) {
    if (isSource(id)) read.add(normalize(id.replace(/[?#].*$/s, "")));
    return null;
  },
});

// The nested build's warnings, as an unresolved `define` or an `eval`, in the
// application's log. Its errors are left out: the build throws them, and they
// are reported as its failure.
const forwarded = (logger: Logger): Logger => ({
  info: () => {},
  warn: (message, options) => logger.warn(`[ibus-web-module] ${message}`, options),
  warnOnce: (message, options) => logger.warnOnce(`[ibus-web-module] ${message}`, options),
  error: () => {},
  clearScreen: () => {},
  hasErrorLogged: (error) => logger.hasErrorLogged(error),
  hasWarned: false,
});

// Vite's own build, with the application's resolution, `define` and
// environment, so that the module bundles as the application's Workers do.
const bundle = async (
  config: ResolvedConfig,
  entry: string,
  { workerPlugins, minify, sourcemap }: ViteModuleOptions,
  read: Set<string>,
): Promise<readonly (Rolldown.OutputChunk | Rolldown.OutputAsset)[]> => {
  const { build } = await import("vite");

  const result = await build({
    configFile: false,
    root: config.root,
    base: config.base,
    mode: config.mode,
    cacheDir: config.cacheDir,
    envDir: config.envDir,
    ...(config.envPrefix === undefined ? {} : { envPrefix: config.envPrefix }),
    resolve: config.resolve,
    ...(config.define === undefined ? {} : { define: config.define }),
    publicDir: false,
    logLevel: "warn",
    customLogger: forwarded(config.logger),
    plugins: [recorder(read), ...(workerPlugins?.() ?? [])],
    build: {
      write: false,
      outDir: outDirOf(config),
      minify,
      sourcemap,
      target: config.build.target,
      copyPublicDir: false,
      emptyOutDir: false,
      reportCompressedSize: false,
      rolldownOptions: { input: entry, ...moduleRolldownOptions },
    },
  });

  return (Array.isArray(result) ? result : [result]).flatMap((output) => ("output" in output ? output.output : []));
};

/** The line a failure is reported with, its tag first; a bundler's message is kept whole, as it may hold a code frame. */
export const tagged = (error: BundleFailed | NotOneFile | ModuleHasAssets | DuplicateModuleName): string =>
  `${error._tag}: ${error.message}`;

/**
 * Builds the module `entry` names: bundled by Vite's own build with the application's `resolve`, `define`, mode and
 * environment and its `worker.plugins`, then made into its files.
 */
export const buildViteModule = async (
  config: ResolvedConfig,
  entry: string,
  options: ViteModuleOptions,
): Promise<ViteModule | ViteModuleFailure> => {
  const read = new Set([entry]);
  const outputs = await bundle(config, entry, options, read).catch(
    (error: unknown) => new BundleFailed({ reason: errorMessage(error) }),
  );
  if (outputs instanceof BundleFailed) return { error: tagged(outputs), sources: [...read] };

  const chunks = outputs.flatMap((output) => (output.type === "chunk" ? [output] : []));
  const [chunk] = chunks;
  if (chunks.length !== 1 || chunk === undefined) {
    return { error: tagged(new NotOneFile({ files: chunks.map(({ fileName }) => fileName) })), sources: [...read] };
  }

  const assets = outputs.flatMap(({ type, fileName }) =>
    type === "asset" && fileName !== `${chunk.fileName}.map` ? [fileName] : [],
  );
  if (assets.length > 0) return { error: tagged(new ModuleHasAssets({ files: assets.sort() })), sources: [...read] };

  const sources = [...new Set([entry, ...chunk.moduleIds.filter(isSource).map((id) => normalize(id))])];
  const output = await outputInWorker({
    script: chunk.code,
    sourceMap: chunk.map?.toString(),
    from: relative(options.outputRoot, resolve(outDirOf(config), dirname(chunk.fileName))).replaceAll("\\", "/"),
    outDir: options.outDir,
    parent: options.parent,
  });

  return "error" in output ? { error: output.error, sources } : { ...output, sources };
};
