// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { dirname, normalize, posix, relative, sep } from "node:path";
import type { ViteDevServer } from "vite";
import { buildViteModule, DuplicateModuleName, moduleQuery, tagged, type ViteModuleOptions } from "./vite-build.ts";

/** What the dev server's modules are built with, but for where their files go. */
export type ServeOptions = Pick<ViteModuleOptions, "workerPlugins" | "outDir">;

/** The dev server's modules, for the plugin's hooks. */
export interface ModuleServer {
  /**
   * The URL a `?ibus-module` import of `entry` gives: its manifest's path in the middleware, once the module has a
   * good build, or the failure of its build.
   */
  manifestUrl(entry: string): Promise<{ readonly url: string } | { readonly error: string }>;
}

const contentType = (fileName: string): string =>
  /\.(?:json|map)$/.test(fileName) ? "application/json; charset=utf-8" : "text/javascript; charset=utf-8";

interface Served {
  readonly entry: string;
  /** Whether the path is one this module answers, built or not. */
  owns(path: string): boolean;
  ready(): Promise<void>;
  files(): ReadonlyMap<string, Uint8Array> | undefined;
  directory(): string | undefined;
  failure(): string | undefined;
}

/**
 * Serves modules from the dev server's middleware, at the paths `vite build` writes their files to: the module the
 * plugin's `entry` names, and each module a `?ibus-module` import names. A module builds on its first request or
 * import, and on a change to one of its sources rebuilds and reloads the page, since hot replacement can't carry an
 * engine's state in its Worker over. A failed build keeps the last good one.
 */
export const serveModules = (
  server: ViteDevServer,
  direct: string | undefined,
  { workerPlugins, outDir }: ServeOptions,
): ModuleServer => {
  const { config } = server;
  const { base } = config;
  const modules: Served[] = [];

  const shown = (entry: string): string => relative(config.root, entry) || entry;

  const invalidateImports = (entry: string): void => {
    for (const environment of Object.values(server.environments)) {
      for (const node of environment.moduleGraph.getModulesByFile(entry) ?? []) {
        if (node.id !== null && moduleQuery.test(node.id)) environment.moduleGraph.invalidateModule(node);
      }
    }
  };

  // `claimed` is a directory the module answers under before its first
  // build, since its name, and so where its files are, is known only after.
  const serve = (entry: string, placement: Pick<ViteModuleOptions, "outDir" | "parent">, claimed?: string): Served => {
    let served: ReadonlyMap<string, Uint8Array> | undefined;
    let directory: string | undefined;
    let failure: string | undefined;
    let sources: ReadonlySet<string> = new Set([entry]);
    // While the last build failed, the directories of what it read, where
    // creating a file it couldn't find, or fixing one, may let it build.
    let suspects: readonly string[] = [];
    let reloadNext = false;
    let running: Promise<void> | undefined;
    let queued: Promise<void> | undefined;

    // Shown in the page's error overlay too, which the reload after the next
    // good build clears.
    const fail = (message: string): void => {
      failure = message;
      config.logger.error(`[ibus-web-module] ${message}`, { timestamp: true });
      server.ws.send({ type: "error", err: { message: `[ibus-web-module] ${message}`, stack: "" } });
    };

    const buildOnce = async (): Promise<void> => {
      const reload = reloadNext;
      reloadNext = false;

      const built = await buildViteModule(config, entry, {
        workerPlugins,
        minify: false,
        sourcemap: true,
        outputRoot: config.root,
        ...placement,
      });
      if ("error" in built) {
        sources = new Set([...sources, ...built.sources]);
        suspects = [...new Set(built.sources.map((source) => dirname(source)))];
        server.watcher.add([...sources, ...suspects]);
        return fail(built.error);
      }

      sources = new Set(built.sources);
      suspects = [];
      server.watcher.add([...sources]);

      const manifest = built.files.find(({ fileName }) => fileName.endsWith("/manifest.json"))!;
      const builtDirectory = `${base}${posix.dirname(manifest.fileName)}`;
      const other = modules.find((module) => module.entry !== entry && module.directory() === builtDirectory);
      if (other !== undefined) {
        return fail(tagged(new DuplicateModuleName({ name: built.name, entries: [shown(other.entry), shown(entry)] })));
      }

      served = new Map(built.files.map(({ fileName, bytes }) => [`${base}${fileName}`, bytes]));
      directory = builtDirectory;
      failure = undefined;
      if (reload) {
        invalidateImports(entry);
        server.ws.send({ type: "full-reload", path: "*" });
      }
      return undefined;
    };

    // One build at a time, and changes during one coalesce into the next.
    const schedule = (): Promise<void> => {
      if (queued !== undefined) return queued;

      const previous = running ?? Promise.resolve();
      queued = previous.then(() => {
        queued = undefined;
        running = buildOnce();
        return running;
      });
      return queued;
    };

    const affects = (file: string): boolean =>
      sources.has(file) ||
      (!file.includes(`${sep}node_modules${sep}`) &&
        suspects.some((directory) => file.startsWith(`${directory}${sep}`)));

    const rebuildFor = (file: string): void => {
      if (running === undefined || !affects(normalize(file))) return;

      reloadNext = true;
      void schedule();
    };
    server.watcher.on("change", rebuildFor);
    server.watcher.on("add", rebuildFor);
    server.watcher.on("unlink", rebuildFor);

    const owns = (path: string): boolean =>
      (directory !== undefined && path.startsWith(`${directory}/`)) ||
      (claimed !== undefined && path.startsWith(`${claimed}/`));

    return {
      entry,
      owns,
      ready: () => queued ?? running ?? schedule(),
      files: () => served,
      directory: () => directory,
      failure: () => failure,
    };
  };

  if (direct !== undefined) {
    const claimed = posix.normalize((outDir ?? "ibus-module").replaceAll("\\", "/")).replace(/\/+$/, "");
    modules.push(serve(direct, { outDir, parent: "ibus-module" }, `${base}${claimed}`));
  }

  server.middlewares.use((request, response, next) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const module = modules.find((candidate) => candidate.owns(path));
    if ((request.method !== "GET" && request.method !== "HEAD") || module === undefined) {
      next();
      return;
    }

    void module.ready().then(() => {
      const bytes = module.files()?.get(path);
      const failure = module.failure();
      if (bytes !== undefined) {
        response.statusCode = 200;
        response.setHeader("Content-Type", contentType(path));
        response.setHeader("Content-Length", bytes.length);
        response.setHeader("Cache-Control", "no-cache");
        response.end(request.method === "HEAD" ? undefined : bytes);
      } else if (module.files() === undefined && failure !== undefined) {
        response.statusCode = 500;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end(failure);
      } else if (module.directory() === undefined || !path.startsWith(`${module.directory()}/`)) {
        // Under a claimed directory but not the module's own, so another
        // of the server's files, such as one from `publicDir`.
        next();
      } else {
        // Not passed on, or Vite's fallback would answer with the page, as
        // for a script an older manifest names.
        response.statusCode = 404;
        response.end();
      }
    }, next);
  });

  return {
    manifestUrl: async (entry) => {
      let module = modules.find((candidate) => candidate.entry === entry);
      if (module === undefined) {
        module = serve(entry, { outDir: undefined, parent: config.build.assetsDir });
        modules.push(module);
      }

      await module.ready();
      const directory = module.directory();
      if (directory === undefined) return { error: module.failure() ?? "" };
      return { url: `${directory}/manifest.json` };
    },
  };
};
