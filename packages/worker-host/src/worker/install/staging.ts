// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Installing one store path of an engine's own data so that a reader, in
// this Worker or another, finds either no store path or the whole of it:
// the archive is extracted under a staging name beside the store path, then
// moved onto it by one rename, which the IndexedDB backend makes in one
// transaction and the Node backend with one rename(2). The caller holds the
// path's install lock, so no other host stages or moves the path meanwhile,
// and holds the backend's window open.

import type { ModuleManifest } from "@ibus-web/protocol";
import { engineDataDir, engineStagingDir, stagingName } from "../../shared/naming.ts";
import { RuntimeRefused, type RuntimeHandle } from "../runtime.ts";
import { installArchives, quieted, type ArchiveHooks, type DataEntry } from "./archive.ts";
import type { Written } from "./writer.ts";

export interface StagingHooks extends ArchiveHooks {
  // Hears a staging tree an earlier install left being removed.
  readonly swept?: (path: string) => void;
}

// What installing the store path did: extracted its archive, or found the
// path already there, and the regular files and bytes of file data it
// holds.
export interface Staged extends Written {
  readonly extracted: boolean;
}

// The calls on trees the install makes through FS, each failing with a
// RuntimeRefused naming the path and the negative errno.
const trees = (handle: RuntimeHandle) => {
  const { FS } = handle.rt;
  const { errno, mode } = handle.fs;
  const refused = (path: string, code: number): RuntimeRefused =>
    new RuntimeRefused(`${JSON.stringify(path)}: -${code}`);
  // An ErrnoError leaves the runtime fit to call; anything else thrown from
  // inside it may not.
  const rethrow = (path: string, error: unknown): never => {
    if (error instanceof FS.ErrnoError) throw refused(path, error.errno);
    throw error;
  };
  const call = <T>(path: string, run: () => T): T => {
    try {
      return run();
    } catch (error) {
      return rethrow(path, error);
    }
  };
  const lstat = (path: string): { mode: number; size: number } | null => {
    try {
      return FS.lstat(path);
    } catch (error) {
      if (error instanceof FS.ErrnoError && error.errno === errno.ENOENT) return null;
      return rethrow(path, error);
    }
  };
  const isDir = (st: { mode: number }): boolean => (st.mode & mode.S_IFMT) === mode.S_IFDIR;
  const children = (path: string): string[] => {
    try {
      return FS.readdir(path).filter((name) => name !== "." && name !== "..");
    } catch (error) {
      // readdir() says so with a plain Error when it can't open the
      // directory, which leaves the runtime fit to call.
      if (error instanceof Error && error.message === "No such directory") throw refused(path, errno.ENOENT);
      return rethrow(path, error);
    }
  };

  // Removes whatever is at path, a tree depth first; whether there was any.
  const remove = (path: string): boolean => {
    const st = lstat(path);
    if (st === null) return false;
    if (isDir(st)) {
      for (const name of children(path)) remove(`${path}/${name}`);
      call(path, () => FS.rmdir(path));
    } else {
      const ret = FS.unlink(path);
      if (ret < 0) throw refused(path, -ret);
    }
    return true;
  };

  // The regular files under path and their bytes.
  const count = (path: string, into: Written = { files: 0, bytes: 0 }): Written => {
    const st = lstat(path);
    if (st === null) throw refused(path, errno.ENOENT);
    if (isDir(st)) for (const name of children(path)) count(`${path}/${name}`, into);
    else if ((st.mode & mode.S_IFMT) === mode.S_IFREG) {
      into.files++;
      into.bytes += st.size;
    }
    return into;
  };

  return {
    exists: (path: string): boolean => lstat(path) !== null,
    remove,
    count,
    rename: (from: string, to: string): void => call(from, () => FS.rename(from, to)),
  };
};

// Installs the store path's archive under its staging name and moves it
// onto the store path. A staging tree an install cut short left is removed
// first. The store path is made only by the move, so one already there is
// whole, its install cut short between the move and the marker: it is
// counted rather than extracted again. An install that fails removes its
// staging tree where the runtime is still fit to call, so that no host's
// file system keeps a staging tree a later install of the path replaces.
export const installStorePath = async (
  handle: RuntimeHandle,
  engine: ModuleManifest,
  entry: DataEntry,
  hooks: StagingHooks,
): Promise<Staged> => {
  const fs = trees(handle);
  const target = engineDataDir(engine, entry);
  const staging = engineStagingDir(engine, entry);

  await quieted(hooks.quiet);
  if (fs.exists(target)) {
    const found = fs.count(target);
    if (found.bytes !== entry.size)
      throw new RuntimeRefused(`${target}: expected ${entry.size} regular-file bytes, found ${found.bytes}`);
    return { extracted: false, ...found };
  }
  if (fs.remove(staging)) hooks.swept?.(staging);

  try {
    const { files, bytes } = await installArchives(handle, engine, [entry], hooks, stagingName);
    await quieted(hooks.quiet);
    fs.rename(staging, target);
    return { extracted: true, files, bytes };
  } catch (error) {
    if (error instanceof RuntimeRefused) {
      try {
        await quieted(hooks.quiet);
        fs.remove(staging);
      } catch (cleanup) {
        if (!(cleanup instanceof RuntimeRefused)) throw cleanup;
      }
    }
    throw error;
  }
};
