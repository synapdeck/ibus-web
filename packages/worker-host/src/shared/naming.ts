// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The names an engine's storage goes by: its IndexedDB databases and the Web
// Locks hosts coordinate through. Stored data is found by these names, so
// they never change.

// What the names are made from: the engine's name, and the version its
// installed data is marked with.
export interface EngineIdentity {
  name: string;
  version: string;
}

// A name or version as it appears in database, lock and directory names:
// no "/", no ":", and never "." or "..", so that one engine's or version's
// names never run into another's.
export const encodeComponent = (text: string): string =>
  encodeURIComponent(text).replace(/[!'()*.~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Where the engine's own files are, as the runtime sees them: one directory
// under /engines, whatever the name holds.
export const engineDir = ({ name }: Pick<EngineIdentity, "name">): string => `/engines/${encodeComponent(name)}`;

// Every archive retains its Nix store identity inside the version's database.
export const engineDataRoot = (_engine: Pick<EngineIdentity, "name">): string => "/nix/store";

// An archive lands at the exact store path compiled into the side module.
export const engineDataDir = (engine: Pick<EngineIdentity, "name">, { storePath }: { storePath: string }): string =>
  `${engineDataRoot(engine)}/${storePath.slice("/nix/store/".length)}`;

// The name a store path of an engine's own data is extracted under, beside
// it, before it is moved onto its store path whole: one no store path has,
// since Nix refuses a store path's name that starts with a dot, and that no
// archive names, since each archive's entries lie under its own store path.
export const stagingName = (storeName: string): string => `.staging-${storeName}`;

export const engineStagingDir = (engine: Pick<EngineIdentity, "name">, { storePath }: { storePath: string }): string =>
  `${engineDataRoot(engine)}/${stagingName(storePath.slice("/nix/store/".length))}`;

// The IndexedDB database the engine's own files live in.
export const engineDatabase = ({ name }: Pick<EngineIdentity, "name">): string => `ibus-web/${encodeComponent(name)}`;

// The prefix of the IndexedDB databases that hold the engine's data, one
// per version; the encoded version follows it.
export const engineDataDatabasePrefix = (engine: Pick<EngineIdentity, "name">): string =>
  `${engineDatabase(engine)}/data/`;

export const engineDataDatabase = (engine: EngineIdentity): string =>
  `${engineDataDatabasePrefix(engine)}${encodeComponent(engine.version)}`;

// The key, in the meta store of a version's data, of the marker of a store
// path of an engine's own data, installed after the version's base data.
export const enginePathMarker = (storePath: string): string => `paths/${storePath}`;

// The Web Lock a version's data is installed under, held exclusively.
export const engineInstallLock = (engine: EngineIdentity): string =>
  `ibus-web:install:${encodeComponent(engine.name)}:${encodeComponent(engine.version)}`;

// The Web Lock one store path of an engine's own data is installed under,
// held exclusively, so that paths install independently of one another.
export const enginePathInstallLock = (engine: EngineIdentity, storePath: string): string =>
  `${engineInstallLock(engine)}:${encodeComponent(storePath)}`;

// The Web Lock the one host that may change the engine's user data holds,
// for as long as it runs; every other host mounts that data read-only.
export const engineWriterLock = ({ name }: Pick<EngineIdentity, "name">): string =>
  `ibus-web:writer:${encodeComponent(name)}`;

// The Cache Storage cache a page preloads engines' files into, which hosts
// read before the network.
export const preloadCacheName = "ibus-web-preload";

const preloadParameter = "ibus-web-preload";

// The key a file of an engine's version is cached under: its URL, without a
// fragment, with the engine's name and version added as a query parameter,
// so that two versions' files at one URL are two entries, and a host finds
// only its own version's.
export const preloadKey = (url: string, engine: EngineIdentity): string => {
  const base = url.split("#", 1)[0]!;
  const owner = encodeURIComponent(`${encodeComponent(engine.name)}/${encodeComponent(engine.version)}`);
  return `${base}${base.includes("?") ? "&" : "?"}${preloadParameter}=${owner}`;
};

// The engine and version, each encoded, whose file a cache key holds, or
// undefined for a key no preload made.
export const preloadOwner = (key: string): EngineIdentity | undefined => {
  const value = new RegExp(`[?&]${preloadParameter}=([^&#]*)`).exec(key)?.[1];
  const parts = value === undefined ? undefined : decodeURIComponent(value).split("/");
  return parts?.length === 2 ? { name: parts[0]!, version: parts[1]! } : undefined;
};

// The Web Lock every host using a version's data holds, shared, for as long
// as it runs; a host takes it exclusively to delete that version's data.
export const engineDataLock = ({ name }: Pick<EngineIdentity, "name">, encodedVersion: string): string =>
  `ibus-web:data:${encodeComponent(name)}:${encodedVersion}`;
