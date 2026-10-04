// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Section lengths and dylink fields are unsigned LEB128 integers, bounded
// to uint32 by the WebAssembly binary format.
class Reader {
  private offset = 0;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  get remaining(): number {
    return this.bytes.length - this.offset;
  }
  byte(): number {
    if (this.remaining === 0) throw new Error("truncated WebAssembly dylink.0 section");
    return this.bytes[this.offset++]!;
  }
  uint32(): number {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      if (shift === 28 && byte > 15) throw new Error("invalid dylink.0 uint32");
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw new Error("invalid dylink.0 uint32");
  }
  take(length: number): Uint8Array {
    if (length > this.remaining) throw new Error("truncated WebAssembly dylink.0 section");
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
}

export const dylinkMemorySize = (bytes: Uint8Array): number => {
  const reader = new Reader(bytes);
  const header = [0, 97, 115, 109, 1, 0, 0, 0];
  if (header.some((byte) => reader.byte() !== byte)) throw new Error("invalid WebAssembly header");
  while (reader.remaining > 0) {
    const id = reader.byte();
    const section = new Reader(reader.take(reader.uint32()));
    if (id !== 0) continue;
    const name = new TextDecoder("utf-8", { fatal: true }).decode(section.take(section.uint32()));
    if (name !== "dylink.0") continue;
    while (section.remaining > 0) {
      const subsection = section.byte();
      const fields = new Reader(section.take(section.uint32()));
      if (subsection === 1) return fields.uint32();
    }
    throw new Error("dylink.0 has no memory info");
  }
  throw new Error("WebAssembly module has no dylink.0 section");
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: dylink.ts MODULE.wasm");
  process.stdout.write(`${dylinkMemorySize(readFileSync(file))}\n`);
}
