// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Data } from "effect";

const ProtocolErrorBase: ReturnType<typeof Data.TaggedError<"ProtocolError">> = Data.TaggedError("ProtocolError");
export class ProtocolError extends ProtocolErrorBase<{ readonly message: string }> {}

type Alignment = 1 | 2 | 4 | 8;
type BasicChar = "b" | "y" | "n" | "q" | "i" | "u" | "h" | "x" | "t" | "d" | "s" | "o" | "g";
interface Layout {
  readonly alignment: Alignment;
  readonly fixedSize: number | undefined;
  readonly signature: string;
  /** GLib's type depth: 1 for a basic type or `v`, one more than the deepest member for a container, 0 for `()`. */
  readonly depth: number;
}
export type GVariantType = Layout &
  (
    | { readonly _tag: "basic"; readonly char: BasicChar }
    | { readonly _tag: "v" }
    | { readonly _tag: "a" | "m"; readonly element: GVariantType }
    | { readonly _tag: "()"; readonly members: readonly GVariantType[] }
    | { readonly _tag: "{}"; readonly key: GVariantType & { readonly _tag: "basic" }; readonly value: GVariantType }
  );

const basics: Readonly<Record<BasicChar, readonly [Alignment, number | undefined]>> = {
  b: [1, 1],
  y: [1, 1],
  n: [2, 2],
  q: [2, 2],
  i: [4, 4],
  u: [4, 4],
  h: [4, 4],
  x: [8, 8],
  t: [8, 8],
  d: [8, 8],
  s: [1, undefined],
  o: [1, undefined],
  g: [1, undefined],
};
const cache = new Map<string, GVariantType>();
export const align = (size: number, alignment: number): number => Math.ceil(size / alignment) * alignment;
const layout = (members: readonly GVariantType[]): Pick<Layout, "alignment" | "fixedSize" | "depth"> => {
  let alignment: Alignment = 1;
  let depth = 0;
  let size: number | undefined = 0;
  for (const member of members) {
    alignment = Math.max(alignment, member.alignment) as Alignment;
    depth = Math.max(depth, member.depth + 1);
    if (size !== undefined)
      size = member.fixedSize === undefined ? undefined : align(size, member.alignment) + member.fixedSize;
  }
  const fixedSize = size === undefined ? undefined : members.length === 0 ? 1 : align(size, alignment);
  return { alignment, fixedSize, depth };
};

const maximumDepth = 128;

// Parses one complete type starting at `start`. The nesting rule is GLib's: a container may not
// open below 128 enclosing containers, but an empty tuple there is allowed because it has no
// member to recurse into.
const scan = (signature: string, start: number): GVariantType => {
  let index = start;
  const fail = (reason: string): never => {
    throw new ProtocolError({ message: `Invalid GVariant type at ${index}: ${reason}` });
  };
  const parse = (depth: number): GVariantType => {
    const first = index;
    const char = signature[index++];
    if (char !== undefined && Object.hasOwn(basics, char)) {
      const [alignment, fixedSize] = basics[char as BasicChar];
      return Object.freeze({ _tag: "basic", char: char as BasicChar, alignment, fixedSize, signature: char, depth: 1 });
    }
    if (char === "v")
      return Object.freeze({ _tag: "v", alignment: 8, fixedSize: undefined, signature: char, depth: 1 });
    if (char === "(") {
      const members: GVariantType[] = [];
      while (signature[index] !== ")") {
        if (index >= signature.length) fail("unterminated tuple");
        if (depth >= maximumDepth) fail("nesting exceeds 128");
        members.push(parse(depth + 1));
      }
      index++;
      return Object.freeze({
        _tag: "()",
        members: Object.freeze(members),
        ...layout(members),
        signature: signature.slice(first, index),
      });
    }
    if (depth >= maximumDepth) fail("nesting exceeds 128");
    if (char === "a" || char === "m") {
      const element = parse(depth + 1);
      return Object.freeze({
        _tag: char,
        element,
        alignment: element.alignment,
        fixedSize: undefined,
        signature: signature.slice(first, index),
        depth: element.depth + 1,
      });
    }
    if (char === "{") {
      const key = parse(depth + 1);
      if (key._tag !== "basic") return fail("dictionary key must be basic");
      const value = parse(depth + 1);
      if (signature[index++] !== "}") fail("dictionary entry must contain two types");
      return Object.freeze({
        _tag: "{}",
        key,
        value,
        ...layout([key, value]),
        signature: signature.slice(first, index),
      });
    }
    return fail("expected a complete definite type");
  };
  return parse(0);
};

export const parseType = (signature: string): GVariantType => {
  const cached = cache.get(signature);
  if (cached !== undefined) return cached;
  const type = scan(signature, 0);
  if (type.signature.length !== signature.length)
    throw new ProtocolError({ message: `Invalid GVariant type at ${type.signature.length}: trailing characters` });
  cache.set(signature, type);
  return type;
};

/**
 * Whether `value` is valid as a `g` value: a D-Bus signature, which is a sequence of complete
 * types without maybe types.
 */
export const isSignature = (value: string): boolean => {
  if (!/^[ybnqiuxthdvasog(){}]*$/.test(value)) return false;
  try {
    for (let index = 0; index < value.length;) index += scan(value, index).signature.length;
  } catch {
    return false;
  }
  return true;
};
