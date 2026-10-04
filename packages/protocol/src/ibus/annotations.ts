// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema, type SchemaAST } from "effect";

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly gvariant?: string;
      readonly ibusType?: string;
      readonly kind?: number;
      readonly reply?: string;
    }
  }
}

export function gvariant<S extends Schema.Top>(type: string): (schema: S) => S {
  return (schema) => schema.annotate({ gvariant: type }) as S;
}

// Annotating a schema that has checks stores the annotation on its last check, so a check added
// after the annotation hides it from `ast.annotations` and from the new last check alike.
export function gvariantTypeOf(ast: SchemaAST.AST): string | undefined {
  const checks = ast.checks ?? [];
  for (let index = checks.length - 1; index >= 0; index--) {
    const type = checks[index]!.annotations?.gvariant;
    if (type !== undefined) return type;
  }
  return ast.annotations?.gvariant;
}

export const Bool = Schema.Boolean.pipe(gvariant("b"));
export const Byte = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 255 })).pipe(
  gvariant("y"),
);
export const Int32 = Schema.Number.check(Schema.isInt32()).pipe(gvariant("i"));
export const Uint32 = Schema.Number.check(Schema.isUint32()).pipe(gvariant("u"));
export const Int64 = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: -(2n ** 63n), maximum: 2n ** 63n - 1n }),
).pipe(gvariant("x"));
export const Uint64 = Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: 2n ** 64n - 1n })).pipe(
  gvariant("t"),
);
export const Str = Schema.String.check(Schema.isPattern(/^[^\0\uD800-\uDFFF]*$/u)).pipe(gvariant("s"));
