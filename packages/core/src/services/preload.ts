// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Fetching engines' files before they are selected: each into the page's
// preload cache, keyed by the module's version, where its Worker's host
// looks before the network. Nothing here starts a Worker or opens a
// module's storage.

import { asError, lazyStorePaths, type ModuleManifest } from "@ibus-web/protocol";
import { preloadCacheName, preloadKey } from "@ibus-web/worker-host";
import { EngineLoadFailed, PrepareEngineError } from "../errors.ts";

/** A module to preload, and one of its engines, whose own data comes too. */
export interface PreloadEntry {
  readonly module: string;
  readonly engine?: string;
}

/** `install`: install the data into the module's storage, not only fetch it. */
export interface PreloadOptions {
  readonly install?: boolean;
}

/** What preloading takes of the page, which tests replace. */
export interface PreloadEnvironment {
  readonly caches: () => CacheStorage | undefined;
  readonly fetch: typeof fetch;
  /** Resolves once the page is idle. */
  readonly idle: () => Promise<void>;
}

// WebKit has no requestIdleCallback, so a page there waits a second.
const idle = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve());
    else setTimeout(resolve, 1000);
  });

export const browserPreload: PreloadEnvironment = {
  caches: () => (globalThis as { caches?: CacheStorage }).caches,
  fetch: (input, init) => fetch(input, init),
  idle,
};

/** Hears an entry's bytes fetched so far, of the total the cache lacked. */
export type PreloadProgress = (bytes: number, total: number) => void;

// One file the cache may lack: where it is, the key it goes under, its size
// in the manifest's terms (the module's bytes, an archive's unpacked size),
// and the error a failed fetch is.
interface File {
  readonly url: string;
  readonly key: string;
  readonly size: number;
  readonly failed: (diagnostic: string) => EngineLoadFailed | PrepareEngineError;
}

// Progress is reported at most this often, besides an entry's first and
// last report.
const PROGRESS_INTERVAL_MS = 100;

// Fetches url into the cache under key, at low priority. The file is
// credited in proportion to its body as it arrives where the response gives
// a length, and in full once it is stored.
const store = async (
  environment: PreloadEnvironment,
  cache: Cache,
  file: File,
  credit: (bytes: number) => void,
): Promise<void> => {
  const response = await environment.fetch(file.url, { priority: "low" });
  if (!response.ok || response.body === null) throw new Error(`fetch ${file.url}: ${response.status}`);

  const length = Number(response.headers.get("Content-Length"));
  let received = 0;
  let credited = 0;
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        // Short of its size until it is stored.
        if (length > 0) {
          const now = Math.max(0, Math.min(file.size - 1, Math.floor((file.size * received) / length)));
          credit(now - credited);
          credited = now;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  // The body is stored as it arrived, decoded, so no header but its type
  // still describes it.
  const type = response.headers.get("Content-Type");
  await cache.put(file.key, new Response(counted, type === null ? {} : { headers: { "Content-Type": type } }));
  credit(file.size - credited);
};

// The files of a module's entries that its cache lacks, each entry's own:
// the manifest is already read, and a file two entries share belongs to the
// first.
const filesOf = (
  module: string,
  manifest: ModuleManifest,
  base: string,
  engines: readonly (string | undefined)[],
): (readonly File[])[] => {
  const resolve = (url: string): string => new URL(url, base).href;
  const lazy = lazyStorePaths(manifest);
  const moduleFailed = (diagnostic: string) => new EngineLoadFailed({ module, diagnostic });
  const seen = new Set<string>();
  const file = (url: string, size: number, failed: File["failed"]): File[] => {
    const resolved = resolve(url);
    const key = preloadKey(resolved, manifest);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ url: resolved, key, size, failed }];
  };

  return engines.map((engine) => {
    const descriptor = manifest.engines.find(({ name }) => name === engine);
    const own = new Set(descriptor?.data ?? []);
    const engineFailed = (diagnostic: string) => new PrepareEngineError({ module, engine: engine!, diagnostic });
    return [
      ...file(manifest.module.url, manifest.module.size, moduleFailed),
      ...manifest.data.flatMap(({ storePath, url, size }) =>
        !lazy.has(storePath) ? file(url, size, moduleFailed) : own.has(storePath) ? file(url, size, engineFailed) : [],
      ),
    ];
  });
};

/**
 * Fetches the module's manifest, at low priority, into the cache under its
 * version, and resolves to the URL its files' URLs are relative to: the
 * response's, after redirects, as the host takes it.
 */
export const cacheManifest = async (
  environment: PreloadEnvironment,
  cache: Cache,
  module: string,
  url: URL,
  manifest: ModuleManifest,
): Promise<string> => {
  try {
    const response = await environment.fetch(url, { priority: "low" });
    if (!response.ok) throw new Error(`fetch ${url.href}: ${response.status}`);
    const base = response.url || url.href;
    await cache.put(preloadKey(base, manifest), response);
    return base;
  } catch (cause) {
    throw new EngineLoadFailed({ module, diagnostic: asError(cause).message });
  }
};

/**
 * Fetches what the cache lacks of a module's entries, one file at a time,
 * each entry's progress reported to progress(index, bytes, total), and
 * rejects with the first file's failure as the tagged error for it.
 */
export const fetchEntries = async (
  environment: PreloadEnvironment,
  cache: Cache,
  module: string,
  manifest: ModuleManifest,
  base: string,
  engines: readonly (string | undefined)[],
  progress: (index: number, bytes: number, total: number) => void,
): Promise<void> => {
  const files = filesOf(module, manifest, base, engines);
  for (const [index, own] of files.entries()) {
    const missing: File[] = [];
    for (const file of own) if ((await cache.match(file.key)) === undefined) missing.push(file);
    const total = missing.reduce((sum, { size }) => sum + size, 0);

    let bytes = 0;
    let reportedAt = -Infinity;
    const report = (force: boolean): void => {
      const now = performance.now();
      if (!force && now - reportedAt < PROGRESS_INTERVAL_MS) return;
      reportedAt = now;
      progress(index, bytes, total);
    };
    report(true);
    for (const file of missing) {
      try {
        await store(environment, cache, file, (credit) => {
          bytes += credit;
          report(false);
        });
      } catch (cause) {
        throw file.failed(asError(cause).message);
      }
    }
    if (missing.length > 0) report(true);
  }
};

/** The page's preload cache, or undefined where the page has none. */
export const openPreloads = async (environment: PreloadEnvironment): Promise<Cache | undefined> =>
  environment.caches()?.open(preloadCacheName);
