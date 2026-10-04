// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";
import { Bool, Int32, Str, Uint32 } from "./annotations.ts";
import { serializable } from "./serializable.ts";

export class IBusAttribute extends Schema.Class<IBusAttribute>("IBusAttribute")(
  serializable("IBusAttribute", {
    type: Uint32.annotate({ description: "Attribute decoration type." }),
    value: Uint32.annotate({ description: "Decoration value, such as underline style or RGB color." }),
    startIndex: Uint32.annotate({ description: "First character index covered by the attribute." }),
    endIndex: Uint32.annotate({
      description: "Exclusive ending character index; 0xffffffff means the end of the text.",
    }),
  }),
  { ibusType: "IBusAttribute" },
) {}

export class IBusAttrList extends Schema.Class<IBusAttrList>("IBusAttrList")(
  serializable("IBusAttrList", {
    attributes: Schema.Array(IBusAttribute).annotate({ description: "Text attributes in their original order." }),
  }),
  { ibusType: "IBusAttrList" },
) {}

export class IBusText extends Schema.Class<IBusText>("IBusText")(
  serializable("IBusText", {
    text: Str.annotate({ description: "Text content." }),
    attrs: IBusAttrList.annotate({ description: "Decorations applied to character ranges in the text." }),
  }),
  { ibusType: "IBusText" },
) {}

export class IBusLookupTable extends Schema.Class<IBusLookupTable>("IBusLookupTable")(
  serializable("IBusLookupTable", {
    pageSize: Uint32.annotate({ description: "Number of candidates per page." }),
    cursorPos: Uint32.annotate({ description: "Cursor position in the candidate list." }),
    cursorVisible: Bool.annotate({ description: "Whether the candidate cursor is visible." }),
    round: Bool.annotate({ description: "Whether cursor movement wraps around the candidate list." }),
    orientation: Int32.annotate({ description: "Candidate display orientation." }),
    candidates: Schema.Array(IBusText).annotate({ description: "Candidate texts in display order." }),
    labels: Schema.Array(IBusText).annotate({ description: "Labels for candidate positions." }),
  }),
  { ibusType: "IBusLookupTable" },
) {}

export class IBusProperty extends Schema.Class<IBusProperty>("IBusProperty")(
  serializable("IBusProperty", {
    key: Str.annotate({ description: "Unique property key." }),
    type: Uint32.annotate({ description: "Property presentation type." }),
    label: IBusText.annotate({ description: "Human-readable property label." }),
    icon: Str.annotate({ description: "Icon name or path." }),
    tooltip: IBusText.annotate({ description: "Tooltip describing the property." }),
    sensitive: Bool.annotate({ description: "Whether the property can be activated." }),
    visible: Bool.annotate({ description: "Whether the property is visible." }),
    state: Uint32.annotate({ description: "Property checked state." }),
    subProps: Schema.suspend((): Schema.Codec<IBusPropList, IBusPropListEncoded> => IBusPropList).annotate({
      description: "Nested properties.",
    }),
    symbol: IBusText.annotate({ description: "Short symbolic property label." }),
  }),
  { ibusType: "IBusProperty" },
) {}

export interface IBusPropListEncoded {
  readonly attachments: Readonly<Record<string, typeof import("../gvariant/schema.ts").GVariantVariant.Type>>;
  readonly properties: readonly (typeof IBusProperty.Encoded)[];
}

export class IBusPropList extends Schema.Class<IBusPropList>("IBusPropList")(
  serializable("IBusPropList", {
    properties: Schema.Array(IBusProperty).annotate({ description: "Properties in display order." }),
  }),
  { ibusType: "IBusPropList" },
) {}

export const KeyEvent = {
  keyval: Uint32.annotate({ description: "Key symbol value." }),
  keycode: Uint32.annotate({ description: "Hardware key code." }),
  state: Uint32.annotate({ description: "Modifier and event state mask." }),
};
