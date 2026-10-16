// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { align, isSignature, parseType, CodecError, type GVariantType } from "./type.ts";
import { type GVariantValue } from "./value.ts";

export function offsetWidth(size: number): number {
  if (size <= 255) return 1;
  if (size <= 65535) return 2;
  if (size <= 4294967295) return 4;
  return 8;
}

export function framingWidth(dataSize: number, offsetCount: number): number {
  let width = 1;
  while (offsetWidth(dataSize + offsetCount * width) > width) width *= 2;
  return width;
}

interface EncodingPlan {
  readonly type: GVariantType;
  readonly value: GVariantValue;
  size: number;
  readonly children: { position: number; plan: EncodingPlan }[];
  readonly offsets: number[];
  offsetWidth: number;
  text?: string;
  textLength: number;
}

const encoder = new TextEncoder();

/** The UTF-8 length of `text`, or -1 if it has an interior NUL or an unpaired surrogate. */
function utf8Length(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit === 0) return -1;
    if (unit < 0x80) length += 1;
    else if (unit < 0x800) length += 2;
    else if (unit < 0xd800 || unit > 0xdfff) length += 3;
    else if (unit > 0xdbff) return -1;
    else {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return -1;
      length += 4;
      index++;
    }
  }
  return length;
}

// Writing a short string by hand avoids TextEncoder's per-call cost, which dominates encoding
// records made of many short strings.
function writeUtf8(bytes: Uint8Array, start: number, text: string, length: number): void {
  if (length > 64) {
    encoder.encodeInto(text, bytes.subarray(start, start + length));
    return;
  }
  let position = start;
  for (let index = 0; index < text.length; index++) {
    let codePoint = text.charCodeAt(index);
    if (codePoint < 0x80) {
      bytes[position++] = codePoint;
      continue;
    }
    if (codePoint >= 0xd800 && codePoint <= 0xdbff)
      codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (text.charCodeAt(++index) - 0xdc00);
    if (codePoint < 0x800) {
      bytes[position++] = 0xc0 | (codePoint >> 6);
    } else if (codePoint < 0x10000) {
      bytes[position++] = 0xe0 | (codePoint >> 12);
      bytes[position++] = 0x80 | ((codePoint >> 6) & 0x3f);
    } else {
      bytes[position++] = 0xf0 | (codePoint >> 18);
      bytes[position++] = 0x80 | ((codePoint >> 12) & 0x3f);
      bytes[position++] = 0x80 | ((codePoint >> 6) & 0x3f);
    }
    bytes[position++] = 0x80 | (codePoint & 0x3f);
  }
}

function invalidValue(message: string): never {
  throw new CodecError({ message });
}

const integerRanges = {
  y: [0, 0xff],
  n: [-0x8000, 0x7fff],
  q: [0, 0xffff],
  i: [-0x80000000, 0x7fffffff],
  h: [-0x80000000, 0x7fffffff],
  u: [0, 0xffffffff],
} as const;
const bigintRanges = {
  x: [-(2n ** 63n), 2n ** 63n - 1n],
  t: [0n, 2n ** 64n - 1n],
} as const;
const objectPath = /^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/;

// DataView setters wrap or truncate what doesn't fit, which would put a different value on the
// wire than the caller asked for.
function checkBasic(value: GVariantValue): void {
  switch (value._tag) {
    case "y":
    case "n":
    case "q":
    case "i":
    case "h":
    case "u": {
      const [minimum, maximum] = integerRanges[value._tag];
      if (!Number.isInteger(value.value) || value.value < minimum || value.value > maximum)
        invalidValue(`GVariant ${value._tag} out of range: ${value.value}`);
      break;
    }
    case "x":
    case "t": {
      const [minimum, maximum] = bigintRanges[value._tag];
      if (typeof value.value !== "bigint" || value.value < minimum || value.value > maximum)
        invalidValue(`GVariant ${value._tag} out of range: ${value.value}`);
      break;
    }
    case "o":
      if (!objectPath.test(value.value)) invalidValue("Invalid GVariant object path");
      break;
    case "g":
      if (!isSignature(value.value)) invalidValue("Invalid GVariant signature");
      break;
  }
}

function measure(type: GVariantType, value: GVariantValue, depth: number): EncodingPlan {
  if (depth >= 128) invalidValue("GVariant nesting exceeds 128");
  const expectedTag = type._tag === "basic" ? type.char : type._tag;
  if (value._tag !== expectedTag) invalidValue(`GVariant value does not match ${type.signature}`);

  const plan: EncodingPlan = { type, value, size: 0, children: [], offsets: [], offsetWidth: 0, textLength: 0 };
  if (type._tag === "basic") {
    checkBasic(value);
    if (value._tag === "s" || value._tag === "o" || value._tag === "g") {
      const length = utf8Length(value.value);
      if (length < 0) invalidValue("Invalid GVariant string");
      plan.text = value.value;
      plan.textLength = length;
      plan.size = length + 1;
    } else {
      plan.size = type.fixedSize!;
    }
    return plan;
  }

  if (type._tag === "v" && value._tag === "v") {
    const childType = parseType(value.type);
    if (depth + childType.depth >= 128) invalidValue("GVariant variant type nests too deeply");
    const child = measure(childType, value.value, depth + 1);
    plan.children.push({ position: 0, plan: child });
    plan.text = value.type;
    plan.textLength = value.type.length;
    plan.size = child.size + 1 + plan.textLength;
    return plan;
  }

  if (type._tag === "m" && value._tag === "m") {
    if (value.value !== null) {
      const child = measure(type.element, value.value, depth + 1);
      plan.children.push({ position: 0, plan: child });
      plan.size = child.size + (type.element.fixedSize === undefined ? 1 : 0);
    }
    return plan;
  }

  let memberValues: readonly GVariantValue[];
  let memberTypes: readonly GVariantType[] | undefined;
  let element: GVariantType | undefined;
  if (type._tag === "a" && value._tag === "a") {
    memberValues = value.items;
    element = type.element;
  } else if (type._tag === "()" && value._tag === "()") {
    memberValues = value.items;
    memberTypes = type.members;
    if (memberTypes.length !== memberValues.length) invalidValue("GVariant member count mismatch");
  } else if (type._tag === "{}" && value._tag === "{}") {
    memberValues = [value.key, value.value];
    memberTypes = [type.key, type.value];
  } else {
    return invalidValue("Expected a GVariant container");
  }
  const last = memberValues.length - 1;
  for (let index = 0; index <= last; index++) {
    const memberType = element ?? memberTypes![index]!;
    const position = align(plan.size, memberType.alignment);
    const child = measure(memberType, memberValues[index]!, depth + 1);
    plan.children.push({ position, plan: child });
    plan.size = position + child.size;
    if (memberType.fixedSize === undefined && (element !== undefined || index < last)) plan.offsets.push(plan.size);
  }

  if (type.fixedSize !== undefined) plan.size = type.fixedSize;
  if (type._tag !== "a") plan.offsets.reverse();
  if (plan.offsets.length > 0) {
    plan.offsetWidth = framingWidth(plan.size, plan.offsets.length);
    plan.size += plan.offsets.length * plan.offsetWidth;
  }
  return plan;
}

function writeOffset(view: DataView, position: number, width: number, value: number): void {
  switch (width) {
    case 8:
      view.setBigUint64(position, BigInt(value), true);
      break;
    case 4:
      view.setUint32(position, value, true);
      break;
    case 2:
      view.setUint16(position, value, true);
      break;
    default:
      view.setUint8(position, value);
  }
}

function writeBasic(plan: EncodingPlan, bytes: Uint8Array, view: DataView, start: number): void {
  const value = plan.value;
  switch (value._tag) {
    case "s":
    case "o":
    case "g":
      writeUtf8(bytes, start, plan.text!, plan.textLength);
      break;
    case "b":
      view.setUint8(start, value.value ? 1 : 0);
      break;
    case "y":
      view.setUint8(start, value.value);
      break;
    case "n":
      view.setInt16(start, value.value, true);
      break;
    case "q":
      view.setUint16(start, value.value, true);
      break;
    case "i":
    case "h":
      view.setInt32(start, value.value, true);
      break;
    case "u":
      view.setUint32(start, value.value, true);
      break;
    case "x":
      view.setBigInt64(start, value.value, true);
      break;
    case "t":
      view.setBigUint64(start, value.value, true);
      break;
    case "d":
      view.setFloat64(start, value.value, true);
      break;
  }
}

function write(plan: EncodingPlan, bytes: Uint8Array, view: DataView, start: number): void {
  if (plan.type._tag === "basic") {
    writeBasic(plan, bytes, view, start);
    return;
  }
  for (let index = 0; index < plan.children.length; index++) {
    const child = plan.children[index]!;
    write(child.plan, bytes, view, start + child.position);
  }
  if (plan.type._tag === "v") writeUtf8(bytes, start + plan.size - plan.textLength, plan.text!, plan.textLength);
  const tableStart = start + plan.size - plan.offsets.length * plan.offsetWidth;
  for (let index = 0; index < plan.offsets.length; index++)
    writeOffset(view, tableStart + index * plan.offsetWidth, plan.offsetWidth, plan.offsets[index]!);
}

export function encodeValue(signature: string, value: GVariantValue): Uint8Array {
  const plan = measure(parseType(signature), value, 0);
  const bytes = new Uint8Array(plan.size);
  write(plan, bytes, new DataView(bytes.buffer), 0);
  return bytes;
}
