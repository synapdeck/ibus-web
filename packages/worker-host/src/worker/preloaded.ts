// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The files a page preloaded into its cache: a host reads its module and
// archives from there before the network, and drops other versions' as its
// version's data is mounted.

import { errorSummary } from "@ibus-web/protocol";
import { encodeComponent, preloadCacheName, preloadKey, preloadOwner, type EngineIdentity } from "../shared/naming.ts";

// The cache, if a page has made it: opening it would make it, and Node has
// no Cache Storage.
const preloads = async (): Promise<Cache | undefined> => {
  const storage = (globalThis as { caches?: CacheStorage }).caches;
  if (storage === undefined || !(await storage.has(preloadCacheName))) return undefined;
  return storage.open(preloadCacheName);
};

// The engine's version's file at url as the page preloaded it, or else as
// the network has it. A cache that can't be read is passed over.
export const fetchPreloaded = async (url: string, engine: EngineIdentity, init?: RequestInit): Promise<Response> => {
  try {
    const found = await (await preloads())?.match(preloadKey(url, engine));
    if (found !== undefined) return found;
  } catch {
    // The network has the file too.
  }
  return fetch(url, init);
};

// Deletes the files the page preloaded of the engine's other versions.
// Best-effort, as collecting their data is: it says why it failed, if it
// did.
export const collectPreloaded = async (engine: EngineIdentity): Promise<string | undefined> => {
  try {
    const cache = await preloads();
    if (cache === undefined) return undefined;
    const name = encodeComponent(engine.name);
    const version = encodeComponent(engine.version);
    for (const request of await cache.keys()) {
      const owner = preloadOwner(request.url);
      if (owner?.name === name && owner.version !== version) await cache.delete(request);
    }
    return undefined;
  } catch (error) {
    return `preloaded files: ${errorSummary(error)}`;
  }
};
