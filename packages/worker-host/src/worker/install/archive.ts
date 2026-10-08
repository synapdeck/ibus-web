// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Streaming the engine's data archives into the runtime's extractor, which
// unpacks each through the mounted file system.

import { errorMessage, type ModuleManifest } from "@ibus-web/protocol";
import { decompressed, type BrotliDecoder } from "./decompress.ts";
import { entryGuard } from "./entries.ts";
import { engineDataRoot } from "../../shared/naming.ts";
import { INSTALL_PIECE } from "../../shared/config.ts";
import { alloc, check, RuntimeRefused, withString, type RuntimeHandle } from "../runtime.ts";
import { makeDirs } from "../storage/mount.ts";

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
  readonly forceBrotliFallback: boolean;
  // Hears which decoder each Brotli archive goes through.
  readonly brotliDecoder: (decoder: BrotliDecoder) => void;
  // Called before each piece is fed; the install waits for it.
  readonly beforePiece: (tally: Tally) => Promise<void> | undefined;
}

// Fetching and reading happen outside the runtime, which they leave fit to
// call.
const outside = async <T>(what: string, promise: Promise<T>): Promise<T> => {
  try {
    return await promise;
  } catch (error) {
    throw new RuntimeRefused(`${what}: ${errorMessage(error)}`);
  }
};

// Streams the archive at url into the extractor, unpacking it into dir, the
// store's root, where its entries must all lie under storeName, and adds
// what it did to tally.
const installArchive = async (
  handle: RuntimeHandle,
  url: string,
  dir: string,
  storeName: string,
  encoding: "br" | "identity",
  expectedBytes: number,
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
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let install = 0;
  let done = false;
  // A failure from inside the runtime leaves it unfit to call, so nothing
  // is freed or ended after one.
  let intact = true;
  // The install's handle, then its count: files, then bytes as a uint64.
  let out = 0;
  let piece = 0;
  try {
    out = alloc(handle, 16);
    piece = alloc(handle, INSTALL_PIECE);
    arrived();
    const response = await outside(`fetch ${url}`, fetch(url, { signal: idle.signal }));
    if (!response.ok || response.body === null) throw new RuntimeRefused(`fetch ${url}: ${response.status}`);
    reader = decompressed(response.body, encoding, hooks.forceBrotliFallback, hooks.brotliDecoder).getReader();
    makeDirs(handle, dir);
    check(
      `ibusweb_install_begin ${dir}`,
      withString(handle, dir, (ptr) => rt._ibusweb_install_begin(ptr, out)),
    );
    install = handle.words[out / 4]! >>> 0;
    check(`install ${url} size limit`, rt._ibusweb_install_set_limit(install, BigInt(expectedBytes)));
    const guard = entryGuard(storeName);
    for (;;) {
      const next = await outside(`fetch ${url}`, reader.read());
      if (next.done) break;
      arrived();
      const { value } = next;
      for (let at = 0; at < value.length; at += INSTALL_PIECE) {
        const part = value.subarray(at, at + INSTALL_PIECE);
        // Time the install spends held up here isn't the archive's to be
        // idle in.
        const held = hooks.beforePiece(tally);
        if (held !== undefined) {
          clearTimeout(timer);
          await held;
          arrived();
        }
        try {
          guard(part);
        } catch (error) {
          throw new RuntimeRefused(`install ${url}: ${errorMessage(error)}`);
        }
        handle.bytes.set(part, piece);
        check(`install ${url} at byte ${tally.fed}`, rt._ibusweb_install_feed(install, piece, part.length));
        tally.fed += part.length;
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
    if (bytes !== expectedBytes)
      throw new RuntimeRefused(`install ${url} size: expected ${expectedBytes} regular-file bytes, got ${bytes}`);
    tally.files += files;
    tally.bytes += bytes;
  } catch (error) {
    intact = error instanceof RuntimeRefused;
    throw error;
  } finally {
    clearTimeout(timer);
    if (intact) {
      if (install !== 0) rt._ibusweb_install_end(install);
      if (piece !== 0) rt._free(piece);
      if (out !== 0) rt._free(out);
    }
    if (reader !== undefined && !done) reader.cancel().catch(() => {});
  }
};

// Installs every archive of the engine's data at the store's root, each at
// its own store path.
export const installArchives = async (
  handle: RuntimeHandle,
  engine: ModuleManifest,
  hooks: ArchiveHooks,
): Promise<Tally> => {
  const tally: Tally = { fed: 0, files: 0, bytes: 0 };
  const root = engineDataRoot(engine);
  for (const data of engine.data) {
    const storeName = data.storePath.slice(data.storePath.lastIndexOf("/") + 1);
    await installArchive(handle, data.url, root, storeName, data.encoding, data.size, tally, hooks);
  }
  return tally;
};
