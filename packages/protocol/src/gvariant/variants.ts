// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { GVariantValue } from "./value.ts";

// A value boxed with its type signature: what settings and attachments
// carry.
type Variant = Extract<GVariantValue, { _tag: "v" }>;

export const variant = (type: string, value: GVariantValue): Variant => ({ _tag: "v", type, value });

export const stringVariant = (value: string): Variant => variant("s", { _tag: "s", value });

export const booleanVariant = (value: boolean): Variant => variant("b", { _tag: "b", value });

export const int32Variant = (value: number): Variant => variant("i", { _tag: "i", value });
