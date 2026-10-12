// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Streaming the engine's data archives through a tar decoder and writing
// each entry through the runtime's file system as its bytes arrive, so
// neither a whole archive nor a whole file is ever held.

import { errorMessage, type ModuleManifest } from "@ibus-web/protocol";
import { createTarDecoder, type TarHeader } from "modern-tar";
import { decompressed, type BrotliDecoder } from "./decompress.ts";
import { entryWriter, type Written } from "./writer.ts";
import { engineDataRoot } from "../../shared/naming.ts";
import { INSTALL_PIECE } from "../../shared/config.ts";
import type { FsConstants } from "../../shared/messages.ts";
import { RuntimeRefused, type RuntimeHandle } from "../runtime.ts";
import { makeDirs } from "../storage/mount.ts";

// What an install has done: archive bytes fed to the decoder, and the
// regular files and bytes of file data written.
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
  // Called before each piece of the archive reaches the decoder; the
  // install waits for it.
  readonly beforePiece: (tally: Tally) => Promise<void> | undefined;
}

// What extract() hears besides the archive hooks: each piece arriving, and
// the install being held before a piece, which the archive's idle time
// leaves out.
export interface ExtractHooks extends Partial<Pick<ArchiveHooks, "beforePiece">> {
  readonly arrived?: () => void;
  readonly holding?: () => void;
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

// The entry's name with empty and "." components dropped, or null if it is
// absolute or has a ".." component. The empty name is the root itself.
export const relativeName = (name: string): string | null => {
  if (name === "" || name.startsWith("/")) return null;
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  return parts.includes("..") ? null : parts.join("/");
};

// Where the entry goes under the store's root, which every archive is
// extracted at, so one whose entries strayed from its own store path could
// replace another's files. Throws for an entry the installer refuses.
export const placeEntry = (header: TarHeader, storeName: string, { errno }: FsConstants): string => {
  const refuse = (code: number): never => {
    throw new RuntimeRefused(`${JSON.stringify(header.name)}: -${code}`);
  };
  // A hard link would name an entry written earlier, which a reader can't
  // trust to be the archive's; archives store each name whole instead.
  if (header.type === "link") refuse(errno.EOPNOTSUPP);
  if (header.type !== "file" && header.type !== "directory" && header.type !== "symlink") refuse(errno.EINVAL);
  // A size from a pax record moves where the entry's data ends, which
  // nothing that writes engine data needs.
  if (header.pax?.["size"] !== undefined) refuse(errno.EINVAL);
  // No store path's names or link targets hold these, and a pax record
  // whose length runs past its own newline leaves one in its value.
  if (/[\0\n]/.test(header.name) || /[\0\n]/.test(header.linkname ?? "")) refuse(errno.EINVAL);
  const name = relativeName(header.name);
  if (name === null) return refuse(errno.EINVAL);
  if (name !== storeName && !name.startsWith(`${storeName}/`))
    throw new RuntimeRefused(`archive entry ${JSON.stringify(name)} lies outside ${storeName}`);
  return name;
};

// Extracts the tar archive streaming from source into dir, an existing
// directory, where its entries must all lie under storeName, writing at
// most limit bytes of file data; adds the archive bytes it fed to tally.fed
// and returns what it wrote. what names the archive in a refusal.
export const extract = async (
  handle: RuntimeHandle,
  source: ReadableStream<Uint8Array>,
  what: string,
  dir: string,
  storeName: string,
  limit: number,
  tally: Tally,
  hooks: ExtractHooks,
): Promise<Written> => {
  const gate = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      hooks.arrived?.();
      for (let at = 0; at < chunk.length; at += INSTALL_PIECE) {
        const piece = chunk.subarray(at, at + INSTALL_PIECE);
        const held = hooks.beforePiece?.(tally);
        if (held !== undefined) {
          hooks.holding?.();
          await held;
          hooks.arrived?.();
        }
        controller.enqueue(piece);
        tally.fed += piece.length;
      }
    },
  });
  // Strict, the decoder refuses a header whose checksum doesn't match and
  // an archive that ends before its end-of-archive blocks, mid-header or
  // mid-file.
  const entries = source
    .pipeThrough(gate)
    .pipeThrough(createTarDecoder({ strict: true }))
    .getReader();
  // Reading fails outside the runtime, as the decoder refusing the archive
  // or its source failing.
  const read = async <T>(promise: Promise<T>): Promise<T> => {
    try {
      return await promise;
    } catch (error) {
      throw new RuntimeRefused(errorMessage(error));
    }
  };
  let done = false;
  // A file's next piece of data, until it is whole.
  const piece = new Uint8Array(INSTALL_PIECE);
  let writer: ReturnType<typeof entryWriter> | undefined;
  try {
    writer = entryWriter(handle, dir, limit);
    for (;;) {
      const next = await read(entries.read());
      if (next.done) break;
      const { header, body } = next.value;
      const name = placeEntry(header, storeName, handle.fs);
      const mode = header.mode ?? 0;
      if (header.type === "directory") {
        writer.directory(name, mode);
      } else if (header.type === "symlink") {
        writer.symlink(name, header.linkname ?? "");
      } else {
        const file = writer.file(name, mode, header.size);
        // The data goes in a piece at a time, each starting at a multiple of
        // the piece's size into the file and whole but for the file's last,
        // so a write covers whole every storage chunk of a size that divides
        // it.
        let left = header.size;
        let held = 0;
        const data = body.getReader();
        for (;;) {
          const chunk = await read(data.read());
          if (chunk.done) break;
          for (let at = 0; at < chunk.value.length;) {
            const want = Math.min(INSTALL_PIECE, left);
            const take = Math.min(chunk.value.length - at, want - held);
            if (take <= 0) throw new RuntimeRefused(`${JSON.stringify(name)}: data past its size`);
            piece.set(chunk.value.subarray(at, at + take), held);
            held += take;
            at += take;
            if (held < want) continue;
            file.write(piece.subarray(0, held));
            left -= held;
            held = 0;
          }
        }
        file.end();
      }
    }
    done = true;
    return writer.written;
  } catch (error) {
    // A failure from inside the runtime leaves it unfit to call, so nothing
    // is closed after one.
    if (!(error instanceof RuntimeRefused)) throw error;
    writer?.abandon();
    throw new RuntimeRefused(`${what}: ${error.message}`);
  } finally {
    if (!done) entries.cancel().catch(() => {});
  }
};

// Fetches the archive at url and extracts it into dir, the store's root,
// where its entries must all lie under storeName; its regular files must
// hold exactly expectedBytes.
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
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arrived = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new Error(`nothing arrived for ${hooks.idleMs} ms`)), hooks.idleMs);
  };
  try {
    arrived();
    const response = await outside(`fetch ${url}`, fetch(url, { signal: idle.signal }));
    if (!response.ok || response.body === null) throw new RuntimeRefused(`fetch ${url}: ${response.status}`);
    const source = decompressed(response.body, encoding, hooks.forceBrotliFallback, hooks.brotliDecoder);
    makeDirs(handle, dir);
    const { files, bytes } = await extract(handle, source, `install ${url}`, dir, storeName, expectedBytes, tally, {
      ...hooks,
      arrived,
      holding: () => clearTimeout(timer),
    });
    if (bytes !== expectedBytes)
      throw new RuntimeRefused(`install ${url} size: expected ${expectedBytes} regular-file bytes, got ${bytes}`);
    tally.files += files;
    tally.bytes += bytes;
  } finally {
    clearTimeout(timer);
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
