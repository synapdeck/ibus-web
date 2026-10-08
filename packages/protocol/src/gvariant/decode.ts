// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Data } from "effect";
import { align, isSignature, parseType, type GVariantType } from "./type.ts";
import { framingWidth, offsetWidth } from "./encode.ts";
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

interface TupleLayout {
  readonly members: readonly GVariantType[];
  /** Members with an entry in the framing table: every variable-size member but the last. */
  readonly offsetCount: number;
}
const tupleLayouts = new WeakMap<TupleType, TupleLayout>();
function tupleLayout(type: TupleType): TupleLayout {
  let layout = tupleLayouts.get(type);
  if (layout === undefined) {
    const members = type._tag === "()" ? type.members : [type.key, type.value];
    let offsetCount = 0;
    for (let index = 0; index < members.length - 1; index++) if (members[index]!.fixedSize === undefined) offsetCount++;
    layout = { members, offsetCount };
    tupleLayouts.set(type, layout);
  }
  return layout;
}

// Calling TextDecoder costs more than decoding a short string by hand, and most strings on the
// wire (candidates, labels, property keys) are short.
const shortText = 64;

/** Strict UTF-8, or `undefined` for anything malformed so the caller can locate the fault. */
function decodeShortUtf8(bytes: Uint8Array, start: number, end: number): string | undefined {
  let text = "";
  let position = start;
  while (position < end) {
    const lead = bytes[position]!;
    if (lead < 0x80) {
      text += String.fromCharCode(lead);
      position++;
      continue;
    }
    let length: number;
    let codePoint: number;
    let minimum: number;
    if (lead >= 0xc2 && lead <= 0xdf) {
      length = 2;
      codePoint = lead & 0x1f;
      minimum = 0x80;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      length = 3;
      codePoint = lead & 0x0f;
      minimum = 0x800;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      length = 4;
      codePoint = lead & 0x07;
      minimum = 0x10000;
    } else {
      return undefined;
    }
    if (position + length > end) return undefined;
    for (let index = 1; index < length; index++) {
      const continuation = bytes[position + index]!;
      if ((continuation & 0xc0) !== 0x80) return undefined;
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (codePoint < minimum || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined;
    text += String.fromCodePoint(codePoint);
    position += length;
  }
  return text;
}

export interface ElementBoundary {
  readonly start: number;
  readonly end: number;
}

type DeferArray = (element: GVariantType, depth: number, boundaries: readonly ElementBoundary[]) => boolean;

class Decoder {
  private readonly view: DataView;

  private readonly bytes: Uint8Array;

  private readonly deferArray: DeferArray | undefined;

  constructor(bytes: Uint8Array, deferArray?: DeferArray) {
    this.deferArray = deferArray;
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private padding(start: number, end: number): void {
    for (let position = start; position < end; position++) {
      if (this.bytes[position] !== 0) fail(position, "nonzero padding");
    }
  }

  private text(start: number, end: number): string {
    if (end - start <= shortText) {
      const text = decodeShortUtf8(this.bytes, start, end);
      if (text !== undefined) return text;
    }
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
    if (tag === "g" && !isSignature(value)) fail(start, "invalid signature");
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

  arrayBoundaries(element: GVariantType, start: number, end: number): ElementBoundary[] {
    const size = end - start;
    const boundaries: ElementBoundary[] = [];
    const fixedSize = element.fixedSize;
    if (fixedSize !== undefined) {
      if (size % fixedSize !== 0) fail(start, "wrong array size");
      for (let position = start; position < end; position += fixedSize) {
        boundaries.push({ start: position, end: position + fixedSize });
      }
      return boundaries;
    }
    if (size === 0) return boundaries;

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
      boundaries.push({ start: start + position, end: start + limit });
      cursor = limit;
    }
    return boundaries;
  }

  private array(element: GVariantType, start: number, end: number, depth: number): GVariantValue {
    const boundaries = this.arrayBoundaries(element, start, end);
    const items = this.deferArray?.(element, depth, boundaries)
      ? []
      : boundaries.map(({ start, end }) => this.read(element, start, end, depth + 1));
    return { _tag: "a", items };
  }

  private tuple(type: TupleType, start: number, end: number, depth: number): GVariantValue {
    const { members, offsetCount } = tupleLayout(type);
    const size = end - start;
    // A zero-byte tuple has no room for offsets; GLib then reads every offset as 0, so members
    // that accept zero bytes (arrays, maybes, such tuples) still decode.
    const width = size === 0 ? 0 : offsetWidth(size);
    const dataEnd = size - offsetCount * width;
    if (dataEnd < 0) fail(start, "missing framing table");
    if (offsetCount > 0 && size > 0 && framingWidth(dataEnd, offsetCount) !== width)
      fail(start + dataEnd, "nonminimal offset width");

    const items: GVariantValue[] = [];
    let cursor = 0;
    let tablePosition = end;
    const last = members.length - 1;
    for (let index = 0; index <= last; index++) {
      const member = members[index]!;
      const position = align(cursor, member.alignment);
      let limit: number;
      let fault = start + cursor;
      if (member.fixedSize !== undefined) {
        limit = position + member.fixedSize;
      } else if (index === last) {
        limit = dataEnd;
      } else if (width === 0) {
        limit = 0;
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
    if (depth >= 128) fail(start, "nesting exceeds 128");
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
        if (depth + child.depth >= 128) fail(separator + 1, "variant type nests too deeply");
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

/** Validates the complete array framing and alignment, leaving element payloads unread. */
export function decodeArrayBoundaries(signature: string, bytes: Uint8Array): readonly ElementBoundary[] {
  const type = readType(signature, 0);
  if (type._tag !== "a") fail(0, "expected array type");
  return new Decoder(bytes).arrayBoundaries(type.element, 0, bytes.length);
}

/** Internal traversal hook: deferred arrays are represented by empty arrays in the tree. */
export function decodeValueWithDeferredArrays(
  signature: string,
  bytes: Uint8Array,
  deferArray: DeferArray,
): GVariantValue {
  return new Decoder(bytes, deferArray).read(readType(signature, 0), 0, bytes.length, 0);
}

/** Retains the enclosing container depth and byte offsets for deferred child validation. */
export function decodeValueRange(
  signature: string,
  bytes: Uint8Array,
  start: number,
  end: number,
  depth: number,
): GVariantValue {
  return new Decoder(bytes).read(readType(signature, start), start, end, depth);
}
