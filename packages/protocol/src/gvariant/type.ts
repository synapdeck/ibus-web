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
const align = (size: number, alignment: Alignment): number => Math.ceil(size / alignment) * alignment;
const layout = (members: readonly GVariantType[]): Pick<Layout, "alignment" | "fixedSize"> => {
  const alignment = members.reduce<Alignment>((maximum, member) => Math.max(maximum, member.alignment) as Alignment, 1);
  let size = 0;
  for (const member of members) {
    if (member.fixedSize === undefined) return { alignment, fixedSize: undefined };
    size = align(size, member.alignment) + member.fixedSize;
  }
  return { alignment, fixedSize: members.length === 0 ? 1 : align(size, alignment) };
};

export const parseType = (signature: string): GVariantType => {
  const cached = cache.get(signature);
  if (cached !== undefined) return cached;
  let index = 0;
  const fail = (reason: string): never => {
    throw new ProtocolError({ message: `Invalid GVariant type at ${index}: ${reason}` });
  };
  const parse = (depth: number): GVariantType => {
    const start = index;
    const char = signature[index++];
    if (char !== undefined && Object.hasOwn(basics, char)) {
      const [alignment, fixedSize] = basics[char as BasicChar];
      return Object.freeze({ _tag: "basic", char: char as BasicChar, alignment, fixedSize, signature: char });
    }
    if (char === "v") return Object.freeze({ _tag: "v", alignment: 8, fixedSize: undefined, signature: char });
    if (depth >= 128) fail("nesting exceeds 128");
    if (char === "a" || char === "m") {
      const element = parse(depth + 1);
      return Object.freeze({
        _tag: char,
        element,
        alignment: element.alignment,
        fixedSize: undefined,
        signature: signature.slice(start, index),
      });
    }
    if (char === "(") {
      const members: GVariantType[] = [];
      while (signature[index] !== ")") {
        if (index >= signature.length) fail("unterminated tuple");
        members.push(parse(depth + 1));
      }
      index++;
      return Object.freeze({
        _tag: "()",
        members: Object.freeze(members),
        ...layout(members),
        signature: signature.slice(start, index),
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
        signature: signature.slice(start, index),
      });
    }
    return fail("expected a complete definite type");
  };
  const type = parse(0);
  if (index !== signature.length) fail("trailing characters");
  cache.set(signature, type);
  return type;
};
