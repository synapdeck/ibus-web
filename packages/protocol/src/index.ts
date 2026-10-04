// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

export { parseType, ProtocolError, type GVariantType } from "./gvariant/type.ts";
export const PROTOCOL_VERSION = 1;
export { type GVariantValue } from "./gvariant/value.ts";
export { encodeValue } from "./gvariant/encode.ts";
export { decodeValue, GVariantDecodeError } from "./gvariant/decode.ts";
export { GVariantTree, GVariantBytes, GVariantVariant } from "./gvariant/schema.ts";
export { signatureOf } from "./ibus/walk.ts";
export { IBusAttribute, IBusAttrList, IBusText, IBusLookupTable, IBusProperty, IBusPropList } from "./ibus/types.ts";
export { IBusAttrType, IBusOrientation, IBusPropType, IBusPropState, IBusPreeditFocusMode } from "./ibus/enums.ts";
