// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Every archive is extracted at the root of the store, so one whose entries
// strayed from its own store path could replace another's files. The guard
// follows the archive's ustar framing as it streams past and refuses an
// entry outside the store path before the extractor sees its header; the
// extractor itself checks everything else about the header. It reads names
// and sizes as the extractor does, so that the two agree on where each
// header lies.

const BLOCK = 512;
const NAME = [0, 100] as const;
const SIZE = [124, 12] as const;
const PREFIX = [345, 155] as const;

const decoder = new TextDecoder();

// A field that need not be NUL-terminated when full.
const text = (header: Uint8Array, [offset, length]: readonly [number, number]): string => {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return decoder.decode(nul === -1 ? field : field.subarray(0, nul));
};

// Octal digits, maybe space-padded before, ended by spaces or NULs; null
// for anything else, which the extractor refuses too.
const octal = (header: Uint8Array, [offset, length]: readonly [number, number]): number | null => {
  const match = /^ *([0-7]+)[ \0]*$/.exec(decoder.decode(header.subarray(offset, offset + length)));
  return match === null ? null : Number.parseInt(match[1]!, 8);
};

// The entry's name with "." and empty components dropped, as the extractor
// resolves it against the directory it installs into.
const entryName = (header: Uint8Array): string => {
  const prefix = header[PREFIX[0]] === 0 ? "" : `${text(header, PREFIX)}/`;
  const full = `${prefix}${text(header, NAME)}`;
  if (full.startsWith("/")) return full;
  return full
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
};

// A guard for an archive of the store path named storeName: called with
// each piece of the archive, in order, before it is fed, it throws if a
// header completed in that piece names an entry outside the store path.
export const entryGuard = (storeName: string): ((piece: Uint8Array) => void) => {
  const header = new Uint8Array(BLOCK);
  let filled = 0;
  // Data and padding still to pass before the next header.
  let skip = 0;
  let zeroBlocks = 0;
  let ended = false;
  return (piece) => {
    let at = 0;
    while (!ended && at < piece.length) {
      if (skip > 0) {
        const passed = Math.min(skip, piece.length - at);
        skip -= passed;
        at += passed;
        continue;
      }
      const taken = Math.min(BLOCK - filled, piece.length - at);
      header.set(piece.subarray(at, at + taken), filled);
      filled += taken;
      at += taken;
      if (filled < BLOCK) break;
      filled = 0;
      if (header.every((byte) => byte === 0)) {
        if (++zeroBlocks === 2) ended = true;
        continue;
      }
      const name = entryName(header);
      if (name !== storeName && !name.startsWith(`${storeName}/`))
        throw new Error(`archive entry ${JSON.stringify(name)} lies outside ${storeName}`);
      const size = octal(header, SIZE);
      // The extractor refuses this header, so where the next would be
      // doesn't matter.
      if (size === null) continue;
      skip = Math.ceil(size / BLOCK) * BLOCK;
    }
  };
};
