// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Tar archives the tests write byte by byte, so that they can be wrong in
// exactly the way a test needs: as JSON, a member can cross from the page
// to a host, which builds the archive there.

const BLOCK = 512;

// A member: a ustar header, then its data padded to a whole block.
export interface Member {
  name: string;
  // The type flag; "0", a regular file, if none.
  type?: string;
  mode?: number;
  // The data, as text or as `size` bytes of a pattern no zeros can pass
  // for, starting at byte `from` of it.
  data?: string | { size: number; from?: number };
  linkname?: string;
  prefix?: string;
  // The size field's 12 bytes as given, rather than the data's length.
  sizeField?: readonly number[];
  // The checksum's octal value as given, rather than the header's.
  checksum?: number;
  // Checksummed as some old writers do, summing the bytes as signed, with
  // bytes that sum differently either way in the owner's name.
  signedSum?: boolean;
}

const encoder = new TextEncoder();

// The pattern's byte at offset: never zero, and different from its
// neighbours.
export const patternByte = (offset: number): number => (offset % 251) + 1;

export const pattern = (size: number, from = 0): Uint8Array => {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = patternByte(from + i);
  return bytes;
};

const dataOf = ({ data }: Member): Uint8Array =>
  data === undefined
    ? new Uint8Array()
    : typeof data === "string"
      ? encoder.encode(data)
      : pattern(data.size, data.from);

const padded = (size: number): number => Math.ceil(size / BLOCK) * BLOCK;

// Copies at most length bytes of text, leaving out the NUL when it fills
// the field.
const put = (block: Uint8Array, offset: number, length: number, text: string): void => {
  block.set(encoder.encode(text).subarray(0, length), offset);
};

const octal = (value: number, digits: number): string => `${value.toString(8).padStart(digits, "0")}\0`;

export const header = (member: Member, size: number): Uint8Array => {
  const block = new Uint8Array(BLOCK);
  put(block, 0, 100, member.name);
  put(block, 100, 8, octal(member.mode ?? 0o644, 7));
  put(block, 108, 8, octal(0, 7));
  put(block, 116, 8, octal(0, 7));
  if (member.sizeField === undefined) put(block, 124, 12, octal(size, 11));
  else block.set(member.sizeField.slice(0, 12), 124);
  put(block, 136, 12, octal(0, 11));
  put(block, 156, 1, member.type ?? "0");
  put(block, 157, 100, member.linkname ?? "");
  put(block, 257, 6, "ustar\0");
  put(block, 263, 2, "00");
  put(block, 345, 155, member.prefix ?? "");
  if (member.signedSum === true) block.fill(0xff, 265, 281);
  block.fill(0x20, 148, 156);
  const sum =
    member.checksum ??
    block.reduce((total, byte) => total + (member.signedSum === true && byte >= 0x80 ? byte - 0x100 : byte), 0);
  put(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
};

export const member = (spec: Member): Uint8Array => {
  const data = dataOf(spec);
  const bytes = new Uint8Array(BLOCK + padded(data.length));
  bytes.set(header(spec, data.length), 0);
  bytes.set(data, BLOCK);
  return bytes;
};

// A pax record: its own length in decimal, then the key and value.
export const paxRecord = (key: string, value: string): string => {
  const body = encoder.encode(` ${key}=${value}\n`).length;
  let length = body + 1;
  while (body + String(length).length !== length) length = body + String(length).length;
  return `${length} ${key}=${value}\n`;
};

// A pax extended header ("x") or global header ("g") holding the records,
// or the text as given.
export const pax = (records: Readonly<Record<string, string>> | string, type: "x" | "g" = "x"): Member => ({
  name: type === "g" ? "pax_global_header" : "PaxHeaders/entry",
  type,
  data:
    typeof records === "string"
      ? records
      : Object.entries(records)
          .map(([key, value]) => paxRecord(key, value))
          .join(""),
});

// GNU's long name ("L") or long link target ("K") for the next member.
export const gnuLong = (type: "L" | "K", value: string): Member => ({
  name: "././@LongLink",
  type,
  data: `${value}\0`,
});

export const END = new Uint8Array(2 * BLOCK);

export const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

// An archive of the members, ended as tar ends one unless end is false.
export const archive = (members: readonly Member[], end = true): Uint8Array =>
  concat(...members.map(member), ...(end ? [END] : []));
