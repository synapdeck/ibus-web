// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The page's preloads: a host reads its module and archives from the
// preload cache before the network, and drops other versions' files as it
// mounts its data. Node has no Cache Storage.

import type { WasmModuleManifest } from "@ibus-web/protocol";
import { expect } from "vitest";
import { preloadCacheName, preloadKey } from "../../src/shared/naming.ts";
import type { Harness, RuntimeBuild } from "../shared/harness.ts";
import { withHosts } from "../shared/install.ts";
import { expectLazyTree, LAZY_PATH, lazyEngineFor, prepareLazy } from "../shared/prepare.ts";

const absolute = (url: string): string => new URL(url, location.href).href;

// Caches what the network has at from as the engine's file at url.
const preload = async (engine: WasmModuleManifest, url: string, from: string): Promise<void> => {
  const response = await fetch(from);
  expect(response.ok, from).toBe(true);
  const cache = await caches.open(preloadCacheName);
  await cache.put(preloadKey(url, engine), new Response(await response.arrayBuffer()));
};

// An engine whose module and lazy archive are at URLs the server doesn't
// have, and the preload cache holds both: the host starts and installs the
// archive from the cache alone.
export const preloadedFiles = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const base = lazyEngineFor(h, "preloaded-files", runtime);
    const lazy = base.data.find(({ storePath }) => storePath === LAZY_PATH)!;
    const moduleUrl = absolute(`missing/${base.name}.wasm`);
    const lazyUrl = absolute(`missing/${base.name}.tar`);
    const engine: WasmModuleManifest = {
      ...base,
      module: { ...base.module, url: moduleUrl },
      data: base.data.map((entry) => (entry.storePath === LAZY_PATH ? { ...entry, url: lazyUrl } : entry)),
    };
    expect((await fetch(moduleUrl)).ok, "the module's URL").toBe(false);
    await preload(engine, moduleUrl, absolute(base.module.url));
    await preload(engine, lazyUrl, absolute(lazy.url));

    const host = await launch(engine).ready;
    await prepareLazy(h, host, "installed");
    await expectLazyTree(h, host.client);
  });

// A host that mounts its version's data deletes the preloads of the
// engine's other versions, and keeps its own version's and another
// engine's.
export const preloadCollected = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "preload-collected", runtime);
    const other = { ...engine, version: `${engine.version}-other` };
    const neighbour = { ...engine, name: `${engine.name}-neighbour` };
    const url = absolute(engine.module.url);
    for (const owner of [engine, other, neighbour]) await preload(owner, url, url);
    const cache = await caches.open(preloadCacheName);

    await launch(engine).ready;
    const keys = (await cache.keys()).map((request) => request.url);
    expect(keys, "its own version's").toContain(preloadKey(url, engine));
    expect(keys, "another engine's").toContain(preloadKey(url, neighbour));
    expect(keys, "another version's").not.toContain(preloadKey(url, other));
  });
