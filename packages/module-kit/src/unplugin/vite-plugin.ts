// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { relative, resolve } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import { buildViteModule, DuplicateModuleName, moduleQuery, tagged, type ViteModuleOptions } from "./vite-build.ts";
import { serveModules, type ModuleServer } from "./vite-dev.ts";

// What the module's own build bundles in place of an input: the module is
// built by the same nested build an import of it gets, so the application's
// own build has nothing left to bundle.
const directEntry = "\0ibus-web-module:entry";

/** The Vite plugin's hooks. */
export const vitePlugin = ({
  entry: directSource,
  outDir,
  minify,
}: {
  readonly entry: string | undefined;
  readonly outDir: string | undefined;
  readonly minify: boolean | undefined;
}): Partial<Plugin> => {
  let workerPlugins: ViteModuleOptions["workerPlugins"];
  let config: ResolvedConfig;
  let direct: string | undefined;
  let server: ModuleServer | undefined;

  // Each module's entry by its name, in one build.
  const names = new Map<string, string>();

  // What each entry's last good build bundled, across the builds of a watch.
  const bundled = new Map<string, readonly string[]>();

  const shown = (entry: string): string => relative(config.root, entry) || entry;

  // Unset, the application's own setting; set, the minifier the application
  // names, or Vite's default when it names none.
  const minified = (): ViteModuleOptions["minify"] => {
    const configured = config.build.minify;
    if (minify === undefined) return configured;
    return minify && (configured === false ? true : configured);
  };

  return {
    config(userConfig, { command }) {
      workerPlugins = userConfig.worker?.plugins;
      if (directSource === undefined || command !== "build") return;

      // `rollupOptions`, when it is the one given, is the object Vite reads as
      // `rolldownOptions`.
      const build = (userConfig.build ??= {});
      const options = build.rolldownOptions ?? build.rollupOptions ?? (build.rolldownOptions = {});
      options.input = directEntry;
    },

    configResolved(resolved) {
      config = resolved;
      direct = directSource === undefined ? undefined : resolve(resolved.root, directSource);
    },

    configureServer(devServer) {
      server = serveModules(devServer, direct, { workerPlugins, outDir });
    },

    buildStart() {
      names.clear();
    },

    resolveId(id) {
      return id === directEntry ? id : undefined;
    },

    async load(id) {
      const entry = id === directEntry ? direct : id.replace(/[?#].*$/s, "");
      if (entry === undefined || (id !== directEntry && !moduleQuery.test(id))) return undefined;

      if (server !== undefined) {
        const served = await server.manifestUrl(entry);
        if ("error" in served) this.error(served.error);
        return { code: `export default ${JSON.stringify(served.url)};`, moduleType: "js" };
      }

      const built = await buildViteModule(config, entry, {
        workerPlugins,
        minify: minified(),
        sourcemap: config.build.sourcemap,
        outputRoot: resolve(config.root, config.build.outDir),
        ...(id === directEntry
          ? { outDir, parent: "ibus-module" }
          : { outDir: undefined, parent: config.build.assetsDir }),
      });
      // A failed build keeps watching what the last good one bundled, as the
      // edit that broke it may be undone.
      const watched = "error" in built ? [...(bundled.get(entry) ?? []), ...built.sources] : built.sources;
      for (const source of new Set(watched)) this.addWatchFile(source);
      if ("error" in built) this.error(built.error);
      bundled.set(entry, built.sources);

      const other = names.get(built.name);
      if (other !== undefined && other !== entry) {
        this.error(tagged(new DuplicateModuleName({ name: built.name, entries: [shown(other), shown(entry)] })));
      }
      names.set(built.name, entry);

      const references = built.files.map(({ fileName, bytes }) => ({
        fileName,
        reference: this.emitFile({ type: "asset", fileName, source: bytes }),
      }));
      if (id === directEntry) return { code: "", moduleType: "js" };

      // Resolved under `base` by Vite's asset handling, as a `?url` import is.
      const manifest = references.find(({ fileName }) => fileName.endsWith("/manifest.json"))!;
      return { code: `export default import.meta.ROLLDOWN_FILE_URL_${manifest.reference};`, moduleType: "js" };
    },

    // An import's node stands for the module's entry in Vite's graph, but
    // its importer can't take it hot, so Vite would reload the page as soon
    // as the entry changes, before the rebuild the server reloads it after.
    hotUpdate({ modules }) {
      return modules.filter((node) => node.id === null || !moduleQuery.test(node.id));
    },

    generateBundle(_, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === "chunk" && output.facadeModuleId === directEntry) delete bundle[fileName];
      }
    },
  };
};
