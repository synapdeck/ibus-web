// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { isSignature, parseType, ProtocolError, type GVariantType } from "./type.ts";
import { isWellFormedString, type GVariantValue } from "./value.ts";

export const align = (size: number, alignment: number): number => Math.ceil(size / alignment) * alignment;

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
  text?: Uint8Array;
}

const encoder = new TextEncoder();

function invalidValue(message: string): never {
  throw new ProtocolError({ message });
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

function containerMembers(
  type: GVariantType,
  value: GVariantValue,
): readonly [readonly GVariantType[], readonly GVariantValue[]] {
  if (type._tag === "a" && value._tag === "a") return [value.items.map(() => type.element), value.items];
  if (type._tag === "()" && value._tag === "()") return [type.members, value.items];
  if (type._tag === "{}" && value._tag === "{}")
    return [
      [type.key, type.value],
      [value.key, value.value],
    ];
  return invalidValue("Expected a GVariant container");
}

function measure(type: GVariantType, value: GVariantValue, depth: number): EncodingPlan {
  if (depth >= 128) invalidValue("GVariant nesting exceeds 128");
  const expectedTag = type._tag === "basic" ? type.char : type._tag;
  if (value._tag !== expectedTag) invalidValue(`GVariant value does not match ${type.signature}`);

  const plan: EncodingPlan = { type, value, size: 0, children: [], offsets: [], offsetWidth: 0 };
  if (type._tag === "basic") {
    checkBasic(value);
    if (value._tag === "s" || value._tag === "o" || value._tag === "g") {
      if (value.value.includes("\0") || !isWellFormedString(value.value)) invalidValue("Invalid GVariant string");
      plan.text = encoder.encode(value.value);
      plan.size = plan.text.length + 1;
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
    plan.text = encoder.encode(value.type);
    plan.size = child.size + 1 + plan.text.length;
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

  const [memberTypes, memberValues] = containerMembers(type, value);
  if (memberTypes.length !== memberValues.length) invalidValue("GVariant member count mismatch");
  for (const [index, memberType] of memberTypes.entries()) {
    const position = align(plan.size, memberType.alignment);
    const child = measure(memberType, memberValues[index]!, depth + 1);
    plan.children.push({ position, plan: child });
    plan.size = position + child.size;
    const needsOffset = memberType.fixedSize === undefined && (type._tag === "a" || index < memberTypes.length - 1);
    if (needsOffset) plan.offsets.push(plan.size);
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
      bytes.set(plan.text!, start);
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
  for (const child of plan.children) write(child.plan, bytes, view, start + child.position);
  if (plan.type._tag === "v") bytes.set(plan.text!, start + plan.size - plan.text!.length);
  for (const [index, offset] of plan.offsets.entries()) {
    const position = start + plan.size - (plan.offsets.length - index) * plan.offsetWidth;
    writeOffset(view, position, plan.offsetWidth, offset);
  }
}

export function encodeValue(signature: string, value: GVariantValue): Uint8Array {
  const plan = measure(parseType(signature), value, 0);
  const bytes = new Uint8Array(plan.size);
  write(plan, bytes, new DataView(bytes.buffer), 0);
  return bytes;
}
