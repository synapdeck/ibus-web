// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { decodeValue, encodeValue } from "../../src/index.ts";
import { signatureOf, toTree, fromTree } from "../../src/ibus/walk.ts";
import { Uint32, Int32 } from "../../src/ibus/annotations.ts";
import {
  IBusAttribute,
  IBusAttrList,
  IBusText,
  IBusLookupTable,
  IBusProperty,
  IBusPropList,
} from "../../src/ibus/types.ts";

function roundTrip<S extends Schema.Top>(schema: S, encoded: S["Encoded"]) {
  const signature = signatureOf(schema);
  const tree = toTree(schema)(encoded);
  expect(fromTree(schema)(tree)).toEqual(encoded);
  const bytes = encodeValue(signature, tree);
  expect(fromTree(schema)(decodeValue(signature, bytes))).toEqual(encoded);
}
const text = (value: string) => ({ attachments: {}, text: value, attrs: { attachments: {}, attributes: [] } });
it("preserves the unsigned attribute end sentinel", () => {
  const attribute = { attachments: {}, type: 1, value: 1, startIndex: 0, endIndex: 0xffffffff };
  roundTrip(IBusAttribute, attribute);
  roundTrip(IBusAttrList, { attachments: {}, attributes: [attribute] });
  roundTrip(IBusText, { ...text("underline"), attrs: { attachments: {}, attributes: [attribute] } });
});
it("round-trips 500 candidates and labels", () => {
  roundTrip(IBusLookupTable, {
    attachments: {},
    pageSize: 9,
    cursorPos: 499,
    cursorVisible: true,
    round: false,
    orientation: -1,
    candidates: Array.from({ length: 500 }, (_, index) => text(`candidate ${index}`)),
    labels: Array.from({ length: 500 }, (_, index) => text(`label ${index}`)),
  });
});
it("round-trips two levels of subproperties", () => {
  const leaf = {
    attachments: {},
    key: "leaf",
    type: 0,
    label: text("label"),
    icon: "",
    tooltip: text("tip"),
    sensitive: true,
    visible: true,
    state: 0,
    subProps: { attachments: {}, properties: [] },
    symbol: text("symbol"),
  };
  const middle = { ...leaf, key: "middle", subProps: { attachments: {}, properties: [leaf] } };
  const root = { ...leaf, key: "root", subProps: { attachments: {}, properties: [middle] } };
  roundTrip(IBusProperty, root);
  roundTrip(IBusPropList, { attachments: {}, properties: [root] });
});
it.each([-1, 2 ** 32])("Uint32 rejects %s", (value) => {
  expect(() => Schema.decodeUnknownSync(Uint32)(value)).toThrow();
});
it("Int32 rejects overflow", () => {
  expect(() => Schema.decodeUnknownSync(Int32)(2 ** 31)).toThrow();
});
it.prop(
  "IBus types round-trip through bytes",
  [IBusText, IBusLookupTable, IBusProperty],
  ([text, table, property]) => {
    roundTrip(IBusText, Schema.encodeSync(IBusText)(text));
    roundTrip(IBusLookupTable, Schema.encodeSync(IBusLookupTable)(table));
    roundTrip(IBusProperty, Schema.encodeSync(IBusProperty)(property));
  },
  { arbitrary: { runs: 100, seed: 3 } },
);
it.each(["\0", "\ud800"])("rejects text that cannot be represented as UTF-8 GVariant: %j", (invalid) => {
  expect(() => Schema.decodeUnknownSync(IBusText)({ ...text(invalid) })).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(IBusText, { onExcessProperty: "error" })({
      ...text("valid"),
      attachments: { [invalid]: { _tag: "v", type: "b", value: { _tag: "b", value: true } } },
    }),
  ).toThrow();
});
