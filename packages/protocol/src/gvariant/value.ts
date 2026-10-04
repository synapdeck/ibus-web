// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

export type GVariantValue =
  | { readonly _tag: "b"; readonly value: boolean }
  | { readonly _tag: "y" | "n" | "q" | "i" | "u" | "h" | "d"; readonly value: number }
  | { readonly _tag: "x" | "t"; readonly value: bigint }
  | { readonly _tag: "s" | "o" | "g"; readonly value: string }
  | { readonly _tag: "v"; readonly type: string; readonly value: GVariantValue }
  | { readonly _tag: "m"; readonly value: GVariantValue | null }
  | { readonly _tag: "a"; readonly items: readonly GVariantValue[] }
  | { readonly _tag: "()"; readonly items: readonly GVariantValue[] }
  | { readonly _tag: "{}"; readonly key: GVariantValue; readonly value: GVariantValue };

function checkValue(input: unknown, depth: number): boolean {
  if (depth > 128 || typeof input !== "object" || input === null) return false;
  const node = input as Record<string, unknown>;
  switch (node._tag) {
    case "b":
      return typeof node.value === "boolean";
    case "y":
    case "n":
    case "q":
    case "i":
    case "u":
    case "h":
    case "d":
      return typeof node.value === "number";
    case "x":
    case "t":
      return typeof node.value === "bigint";
    case "s":
    case "o":
    case "g":
      return typeof node.value === "string";
    case "v":
      return typeof node.type === "string" && checkValue(node.value, depth + 1);
    case "m":
      return node.value === null || checkValue(node.value, depth + 1);
    case "a":
    case "()":
      return Array.isArray(node.items) && node.items.every((item) => checkValue(item, depth + 1));
    case "{}":
      return checkValue(node.key, depth + 1) && checkValue(node.value, depth + 1);
    default:
      return false;
  }
}

export function isGVariantValue(input: unknown): input is GVariantValue {
  return checkValue(input, 0);
}

export function isWellFormedString(value: string): boolean {
  // Unicode mode consumes valid surrogate pairs as one code point.
  return !/[\uD800-\uDFFF]/u.test(value);
}
