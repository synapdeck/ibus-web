// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Data } from "effect";
import { parseType, type GVariantType } from "./type.ts";
import { align, framingWidth, offsetWidth } from "./encode.ts";
import { type GVariantValue } from "./value.ts";

const DecodeErrorBase: ReturnType<typeof Data.TaggedError<"GVariantDecodeError">> =
  Data.TaggedError("GVariantDecodeError");
export class GVariantDecodeError extends DecodeErrorBase<{ readonly message: string; readonly offset: number }> {}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
type BasicType = GVariantType & { readonly _tag: "basic" };
type TupleType = GVariantType & { readonly _tag: "()" | "{}" };

function fail(offset: number, message: string): never {
  throw new GVariantDecodeError({ message, offset });
}

function readType(signature: string, offset: number): GVariantType {
  try {
    return parseType(signature);
  } catch {
    return fail(offset, "invalid type string");
  }
}

function validateSignature(signature: string, offset: number): void {
  let cursor = 0;
  function scan(depth: number): void {
    const character = signature[cursor++];
    if (character !== undefined && "bynqiuhxtdsogv".includes(character)) return;
    if (depth >= 128) fail(offset, "signature nesting exceeds 128");
    if (character === "a") {
      scan(depth + 1);
      return;
    }
    if (character === "(" || character === "{") {
      const closing = character === "(" ? ")" : "}";
      while (cursor < signature.length && signature[cursor] !== closing) scan(depth + 1);
      if (signature[cursor++] !== closing) fail(offset, "unterminated signature");
      return;
    }
    fail(offset, "invalid signature");
  }
  while (cursor < signature.length) {
    const start = cursor;
    scan(0);
    readType(signature.slice(start, cursor), offset);
  }
}

class Decoder {
  private readonly view: DataView;

  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private padding(start: number, end: number): void {
    for (let position = start; position < end; position++) {
      if (this.bytes[position] !== 0) fail(position, "nonzero padding");
    }
  }

  private text(start: number, end: number): string {
    try {
      return decoder.decode(this.bytes.subarray(start, end));
    } catch {
      return fail(this.invalidUtf8Offset(start, end), "invalid UTF-8");
    }
  }

  private invalidUtf8Offset(start: number, end: number): number {
    let sequenceStart = start;
    try {
      for (let position = start; position < end; position++) {
        const character = decoder.decode(this.bytes.subarray(position, position + 1), { stream: true });
        if (character.length > 0) sequenceStart = position + 1;
      }
      decoder.decode();
    } catch {
      return sequenceStart;
    } finally {
      // Finish the stream so a failed partial sequence cannot affect the next value.
      try {
        decoder.decode();
      } catch {
        // Flushing an incomplete sequence resets the stream even when it throws.
      }
    }
    return start;
  }

  private string(tag: "s" | "o" | "g", start: number, end: number): GVariantValue {
    if (start === end || this.bytes[end - 1] !== 0) fail(Math.max(start, end - 1), "missing NUL terminator");
    for (let position = start; position < end - 1; position++) {
      if (this.bytes[position] === 0) fail(position, "interior NUL");
    }
    const value = this.text(start, end - 1);
    if (tag === "o" && !/^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/.test(value)) fail(start, "invalid object path");
    if (tag === "g") validateSignature(value, start);
    return { _tag: tag, value };
  }

  private basic(type: BasicType, start: number, end: number): GVariantValue {
    const tag = type.char;
    switch (tag) {
      case "b":
        if (this.bytes[start]! > 1) fail(start, "invalid boolean");
        return { _tag: tag, value: this.bytes[start] === 1 };
      case "y":
        return { _tag: tag, value: this.view.getUint8(start) };
      case "n":
        return { _tag: tag, value: this.view.getInt16(start, true) };
      case "q":
        return { _tag: tag, value: this.view.getUint16(start, true) };
      case "i":
      case "h":
        return { _tag: tag, value: this.view.getInt32(start, true) };
      case "u":
        return { _tag: tag, value: this.view.getUint32(start, true) };
      case "x":
        return { _tag: tag, value: this.view.getBigInt64(start, true) };
      case "t":
        return { _tag: tag, value: this.view.getBigUint64(start, true) };
      case "d":
        return { _tag: tag, value: this.view.getFloat64(start, true) };
      default:
        return this.string(tag, start, end);
    }
  }

  private offset(position: number, width: number, start: number, end: number): number {
    if (position < start || position + width > end) fail(Math.max(start, position), "missing framing offset");
    let value: number;
    switch (width) {
      case 8:
        value = Number(this.view.getBigUint64(position, true));
        break;
      case 4:
        value = this.view.getUint32(position, true);
        break;
      case 2:
        value = this.view.getUint16(position, true);
        break;
      default:
        value = this.view.getUint8(position);
    }
    if (!Number.isSafeInteger(value) || value > end - start) fail(position, "framing offset out of bounds");
    return value;
  }

  private array(element: GVariantType, start: number, end: number, depth: number): GVariantValue {
    const size = end - start;
    const items: GVariantValue[] = [];
    const fixedSize = element.fixedSize;
    if (fixedSize !== undefined) {
      if (size % fixedSize !== 0) fail(start, "wrong array size");
      for (let position = start; position < end; position += fixedSize) {
        items.push(this.read(element, position, position + fixedSize, depth + 1));
      }
      return { _tag: "a", items };
    }
    if (size === 0) return { _tag: "a", items };

    const width = offsetWidth(size);
    const dataEnd = this.offset(end - width, width, start, end);
    const tableSize = size - dataEnd;
    if (tableSize === 0 || tableSize % width !== 0) fail(end - width, "invalid framing table");
    const count = tableSize / width;
    if (framingWidth(dataEnd, count) !== width) fail(start + dataEnd, "nonminimal offset width");

    let cursor = 0;
    for (let index = 0; index < count; index++) {
      const offsetPosition = start + dataEnd + index * width;
      const limit = this.offset(offsetPosition, width, start, end);
      const position = align(cursor, element.alignment);
      if (limit < position || limit > dataEnd) fail(offsetPosition, "framing offsets out of order or bounds");
      this.padding(start + cursor, start + position);
      items.push(this.read(element, start + position, start + limit, depth + 1));
      cursor = limit;
    }
    return { _tag: "a", items };
  }

  private tuple(type: TupleType, start: number, end: number, depth: number): GVariantValue {
    const members = type._tag === "()" ? type.members : [type.key, type.value];
    const offsetCount = members.slice(0, -1).filter((member) => member.fixedSize === undefined).length;
    const width = offsetWidth(end - start);
    const dataEnd = end - start - offsetCount * width;
    if (dataEnd < 0) fail(start, "missing framing table");
    if (offsetCount > 0 && framingWidth(dataEnd, offsetCount) !== width)
      fail(start + dataEnd, "nonminimal offset width");

    const items: GVariantValue[] = [];
    let cursor = 0;
    let tablePosition = end;
    for (const [index, member] of members.entries()) {
      const position = align(cursor, member.alignment);
      let limit: number;
      let fault = start + cursor;
      if (member.fixedSize !== undefined) {
        limit = position + member.fixedSize;
      } else if (index === members.length - 1) {
        limit = dataEnd;
      } else {
        tablePosition -= width;
        fault = tablePosition;
        limit = this.offset(tablePosition, width, start, end);
      }
      if (limit < position || limit > dataEnd) fail(fault, "framing offsets out of order or bounds");
      this.padding(start + cursor, start + position);
      items.push(this.read(member, start + position, start + limit, depth + 1));
      cursor = limit;
    }
    if (type.fixedSize !== undefined) this.padding(start + cursor, start + dataEnd);
    else if (cursor !== dataEnd) fail(start + cursor, "unused tuple data");

    if (type._tag === "()") return { _tag: "()", items };
    return { _tag: "{}", key: items[0]!, value: items[1]! };
  }

  read(type: GVariantType, start: number, end: number, depth: number): GVariantValue {
    if (depth > 128) fail(start, "nesting exceeds 128");
    const size = end - start;
    if (size < 0 || end > this.bytes.length) fail(start, "invalid value bounds");
    if (type.fixedSize !== undefined && size !== type.fixedSize) fail(start, "wrong fixed size");

    switch (type._tag) {
      case "basic":
        return this.basic(type, start, end);
      case "a":
        return this.array(type.element, start, end, depth);
      case "()":
      case "{}":
        return this.tuple(type, start, end, depth);
      case "v": {
        let separator = end - 1;
        while (separator >= start && this.bytes[separator] !== 0) separator--;
        if (separator < start) fail(start, "missing variant separator");
        const signature = this.text(separator + 1, end);
        const child = readType(signature, separator + 1);
        return { _tag: "v", type: signature, value: this.read(child, start, separator, depth + 1) };
      }
      case "m": {
        if (size === 0) return { _tag: "m", value: null };
        if (type.element.fixedSize === undefined) {
          if (this.bytes[end - 1] !== 0) fail(end - 1, "nonzero maybe terminator");
          end--;
        }
        return { _tag: "m", value: this.read(type.element, start, end, depth + 1) };
      }
    }
  }
}

export function decodeValue(signature: string, bytes: Uint8Array): GVariantValue {
  return new Decoder(bytes).read(readType(signature, 0), 0, bytes.length, 0);
}
