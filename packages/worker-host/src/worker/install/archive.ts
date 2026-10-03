// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Streaming the engine's data archives into the runtime's extractor, which
// unpacks each through the mounted file system.

import { engineDataDir } from "../../shared/naming.ts";
import type { EngineManifest } from "../../shared/messages.ts";
import { alloc, check, RuntimeRefused, withString, type RuntimeHandle } from "../runtime.ts";
import { makeDirs } from "../storage/mount.ts";

// The response body reaches the extractor through a buffer of this size in
// the runtime's memory, which also bounds each of the extractor's writes.
const INSTALL_PIECE = 65536;

// What an install has done: archive bytes fed, and the regular files and
// bytes of file data written.
export interface Tally {
  fed: number;
  files: number;
  bytes: number;
}

export interface ArchiveHooks {
  // An archive that sends nothing for this long fails the install.
  readonly idleMs: number;
  // Called as each piece of an archive reaches the extractor.
  readonly progressed: () => void;
  // Called before each piece is fed; the install waits for it.
  readonly beforePiece: (tally: Tally) => Promise<void> | undefined;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Fetching and reading happen outside the runtime, which they leave fit to
// call.
const outside = async <T>(what: string, promise: Promise<T>): Promise<T> => {
  try {
    return await promise;
  } catch (error) {
    throw new RuntimeRefused(`${what}: ${messageOf(error)}`);
  }
};

// Streams the archive at url into the extractor, unpacking it into dir, and
// adds what it did to tally.
const installArchive = async (
  handle: RuntimeHandle,
  url: string,
  dir: string,
  tally: Tally,
  hooks: ArchiveHooks,
): Promise<void> => {
  const { rt } = handle;
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arrived = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new Error(`nothing arrived for ${hooks.idleMs} ms`)), hooks.idleMs);
  };
  arrived();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let install = 0;
  let done = false;
  // A failure from inside the runtime leaves it unfit to call, so nothing
  // is freed or ended after one.
  let intact = true;
  // The install's handle, then its count: files, then bytes as a uint64.
  const out = alloc(handle, 16);
  const piece = alloc(handle, INSTALL_PIECE);
  try {
    const response = await outside(`fetch ${url}`, fetch(url, { signal: idle.signal }));
    if (!response.ok || response.body === null) throw new RuntimeRefused(`fetch ${url}: ${response.status}`);
    reader = response.body.getReader();
    makeDirs(handle, dir);
    check(
      `ibusweb_install_begin ${dir}`,
      withString(handle, dir, (ptr) => rt._ibusweb_install_begin(ptr, out)),
    );
    install = handle.words[out / 4]! >>> 0;
    for (;;) {
      const next = await outside(`fetch ${url}`, reader.read());
      if (next.done) break;
      arrived();
      const { value } = next;
      for (let at = 0; at < value.length; at += INSTALL_PIECE) {
        const part = value.subarray(at, at + INSTALL_PIECE);
        await hooks.beforePiece(tally);
        handle.bytes.set(part, piece);
        check(`install ${url} at byte ${tally.fed}`, rt._ibusweb_install_feed(install, piece, part.length));
        tally.fed += part.length;
        hooks.progressed();
      }
    }
    done = true;
    rt._ibusweb_install_count(install, out + 4, out + 8);
    const { words } = handle;
    const files = words[(out + 4) / 4]! >>> 0;
    const bytes = (words[(out + 8) / 4]! >>> 0) + (words[(out + 12) / 4]! >>> 0) * 2 ** 32;
    const ended = rt._ibusweb_install_end(install);
    install = 0;
    check(`install ${url}`, ended);
    tally.files += files;
    tally.bytes += bytes;
  } catch (error) {
    intact = error instanceof RuntimeRefused;
    throw error;
  } finally {
    clearTimeout(timer);
    if (intact) {
      if (install !== 0) rt._ibusweb_install_end(install);
      rt._free(piece);
      rt._free(out);
    }
    if (reader !== undefined && !done) reader.cancel().catch(() => {});
  }
};

// Installs every archive of the engine's data under its data directory.
export const installArchives = async (
  handle: RuntimeHandle,
  engine: EngineManifest,
  hooks: ArchiveHooks,
): Promise<Tally> => {
  const tally: Tally = { fed: 0, files: 0, bytes: 0 };
  for (const data of engine.data) await installArchive(handle, data.url, engineDataDir(engine, data), tally, hooks);
  return tally;
};
