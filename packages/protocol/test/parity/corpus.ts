// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";
import * as P from "../../src/index.ts";

export const schemaId = "org.example.Parity";
export function text(value: string, attributes: P.IBusAttribute[] = []): P.IBusText {
  return P.IBusText.make({ attachments: {}, text: value, attrs: P.IBusAttrList.make({ attachments: {}, attributes }) });
}
const attributes = [
  P.IBusAttribute.make({ attachments: {}, type: 1, value: 1, startIndex: 0, endIndex: 2 }),
  P.IBusAttribute.make({ attachments: {}, type: 2, value: 0x123456, startIndex: 1, endIndex: 0xffffffff }),
];
export const decorated = text("한글😀", attributes);
export const table = P.IBusLookupTable.make({
  attachments: {},
  pageSize: 9,
  cursorPos: 20,
  cursorVisible: true,
  round: false,
  orientation: 1,
  candidates: Array.from({ length: 500 }, (_, index) => text(`후보 ${index}`)),
  labels: Array.from({ length: 9 }, (_, index) => text(`${index + 1}`)),
});
function property(key: string, children: P.IBusProperty[] = []): P.IBusProperty {
  return P.IBusProperty.make({
    attachments: {},
    key,
    type: children.length ? 3 : 1,
    label: text("Label"),
    icon: "parity-icon",
    tooltip: text("도움말"),
    sensitive: true,
    visible: true,
    state: 1,
    subProps: P.IBusPropList.make({ attachments: {}, properties: children }),
    symbol: text("★"),
  });
}
export const menu = P.IBusProperty.make({
  ...property("menu", [property("child")]),
  attachments: {
    source: { _tag: "v", type: "s", value: { _tag: "s", value: "typescript" } },
  },
});
export const objectSchemas = {
  IBusAttribute: P.IBusAttribute,
  IBusAttrList: P.IBusAttrList,
  IBusText: P.IBusText,
  IBusLookupTable: P.IBusLookupTable,
  IBusProperty: P.IBusProperty,
  IBusPropList: P.IBusPropList,
};
export const objects = [
  { name: "attribute", type: "IBusAttribute", value: attributes[1]! },
  { name: "empty-attrs", type: "IBusAttrList", value: text("").attrs },
  { name: "empty-text", type: "IBusText", value: text("") },
  { name: "ascii", type: "IBusText", value: text("ASCII") },
  { name: "hangul", type: "IBusText", value: text("한글") },
  { name: "astral", type: "IBusText", value: text("😀") },
  { name: "decorated", type: "IBusText", value: decorated },
  { name: "lookup", type: "IBusLookupTable", value: table },
  { name: "property", type: "IBusProperty", value: menu },
  { name: "properties", type: "IBusPropList", value: P.IBusPropList.make({ attachments: {}, properties: [menu] }) },
  { name: "empty-properties", type: "IBusPropList", value: P.IBusPropList.make({ attachments: {}, properties: [] }) },
] as const;
export const lifecycle = {
  init: new P.Init({
    version: 1,
    settings: { [schemaId]: { sample: { _tag: "v", type: "s", value: { _tag: "s", value: "initial" } } } },
  }),
  create: new P.CreateEngine({ name: "parity" }),
  destroy: new P.DestroyEngine({}),
};
export const requests: readonly { name: string; value: P.Request; result: number }[] = [
  { name: "accepted", value: new P.ProcessKeyEvent({ keyval: 97, keycode: 38, state: 4 }), result: 1 },
  { name: "declined", value: new P.ProcessKeyEvent({ keyval: 98, keycode: 56, state: 1 }), result: 0 },
  ...[
    new P.FocusIn({}),
    new P.FocusOut({}),
    new P.Reset({}),
    new P.Enable({}),
    new P.Disable({}),
    new P.SetCursorLocation({ x: -12, y: 34, width: 5, height: 67 }),
    new P.SetCapabilities({ capabilities: 31 }),
    new P.PageUp({}),
    new P.PageDown({}),
    new P.CursorUp({}),
    new P.CursorDown({}),
    new P.CandidateClicked({ index: 23, button: 2, state: 4 }),
    new P.PropertyActivate({ name: "menu", state: 1 }),
    new P.SetSurroundingText({ text: decorated, cursor: 2, anchor: 1 }),
    new P.SetContentType({ purpose: 3, hints: 32 }),
    new P.SettingChanged({
      schemaId,
      key: "sample",
      value: { _tag: "v", type: "s", value: { _tag: "s", value: "changed" } },
    }),
  ].map((value) => ({ name: value._tag, value, result: 0 })),
];

export function project(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(project);
  if (value === null || typeof value !== "object") return value;
  const fields = Object.entries(value);
  return Object.fromEntries(
    fields
      .filter(([key]) => key !== "_tag")
      .map(([key, child]) => {
        if (key === "attachments")
          return [
            key,
            Object.fromEntries(
              Object.entries(child).map(([name, variant]) => [name, (variant as { type: string }).type]),
            ),
          ];
        return [key, project(child)];
      }),
  );
}
export function encodedObject(type: keyof typeof objectSchemas, value: unknown) {
  return Schema.encodeUnknownSync(objectSchemas[type])(value);
}
