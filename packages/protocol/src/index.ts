// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

export { parseType, ProtocolError, type GVariantType } from "./gvariant/type.ts";
export const PROTOCOL_VERSION = 1;
export { type GVariantValue } from "./gvariant/value.ts";
export { encodeValue } from "./gvariant/encode.ts";
export { decodeValue, GVariantDecodeError } from "./gvariant/decode.ts";
export { GVariantTree, GVariantBytes, GVariantVariant } from "./gvariant/schema.ts";
