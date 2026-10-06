// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";
import {
  IBusAttrList,
  IBusText,
  IBusLookupTable,
  UpdateLookupTable,
  decodeRecord,
  decodeLookupTableRecord,
  decodeRecordLazy,
  decodeArrayBoundaries,
  encodeValue,
  signatureOf,
  type GVariantValue,
} from "../../src/index.ts";
import { toTree } from "../../src/ibus/walk.ts";

const text = (value: string) =>
  IBusText.make({ attachments: {}, text: value, attrs: IBusAttrList.make({ attachments: {}, attributes: [] }) });
function fixture(count = 20, pageSize = 9, cursorPos = 10) {
  const record = new UpdateLookupTable({
    visible: true,
    table: IBusLookupTable.make({
      attachments: {},
      pageSize,
      cursorPos,
      cursorVisible: count % 2 === 0,
      round: cursorPos % 2 === 0,
      orientation: count % 3,
      candidates: Array.from({ length: count }, (_, i) => text(`candidate-${i}-한글`)),
      labels: Array.from({ length: 16 }, (_, i) => text(`label-${i}`)),
    }),
  });
  const tree = toTree(UpdateLookupTable)(Schema.encodeSync(UpdateLookupTable)(record));
  const payload = encodeValue(signatureOf(UpdateLookupTable), tree);
  const bytes = new Uint8Array(Math.ceil((16 + payload.length) / 8) * 8);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 1, true);
  header.setUint32(4, 7, true);
  header.setUint16(8, 4, true);
  header.setUint32(12, payload.length, true);
  bytes.set(payload, 16);
  return { bytes, record, tree };
}
const integer = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));
it.prop(
  "every lazy page matches the eager candidate slice and page-position labels",
  [integer(0, 600), integer(1, 16), integer(0, 100000)],
  ([count, pageSize, cursor]) => {
    const { bytes } = fixture(count, pageSize, count === 0 ? 0 : cursor % count);
    const eager = decodeRecord(bytes).record;
    if (eager._tag !== "UpdateLookupTable") throw new Error("wrong fixture");
    const lazy = decodeLookupTableRecord(bytes);
    expect(lazy).toMatchObject({
      count,
      pageSize,
      cursorPos: eager.table.cursorPos,
      cursorVisible: eager.table.cursorVisible,
      round: eager.table.round,
      orientation: eager.table.orientation,
    });
    for (let page = 0; page <= Math.ceil(count / pageSize); page++) {
      const candidates = eager.table.candidates.slice(page * pageSize, (page + 1) * pageSize);
      expect(lazy.page(page)).toEqual({
        candidates,
        labels: candidates.length ? eager.table.labels.slice(0, pageSize) : [],
      });
    }
    expect(lazy.visible()).toEqual(lazy.page(Math.floor(eager.table.cursorPos / pageSize)));
  },
  { arbitrary: { runs: 40, seed: 1403 } },
);

it("defers malformed invisible candidate bytes until that page is requested", () => {
  const { bytes } = fixture();
  const position = Buffer.from(bytes).indexOf(Buffer.from("candidate-19-한글"));
  bytes[position] = 0xff;
  expect(() => decodeRecord(bytes)).toThrow();
  const lazy = decodeLookupTableRecord(bytes);
  expect(lazy.page(0).candidates).toHaveLength(9);
  expect(() => lazy.page(2)).toThrow();
  const decoded = decodeRecordLazy(bytes);
  expect(decoded).toMatchObject({
    seq: 1,
    ic: 7,
    flags: 0,
    size: bytes.length,
    record: { _tag: "UpdateLookupTable", visible: true },
  });
});

it("retains an immutable snapshot of caller bytes", () => {
  const { bytes, record } = fixture();
  const lazy = decodeLookupTableRecord(bytes);
  bytes.fill(0);
  expect(lazy.page(2).candidates).toEqual(record.table.candidates.slice(18));
});

it("validates candidate av framing before any page is requested", () => {
  const { bytes, tree } = fixture();
  const table = (tree as Extract<GVariantValue, { _tag: "()" }>).items[0]! as Extract<GVariantValue, { _tag: "v" }>;
  const candidates = (table.value as Extract<GVariantValue, { _tag: "()" }>).items[7]!;
  const array = encodeValue("av", candidates);
  const position = Buffer.from(bytes).indexOf(array);
  expect(position).toBeGreaterThan(16);
  bytes[position + array.length - 1] = 0xff;
  expect(() => decodeLookupTableRecord(bytes)).toThrow();
});

it("handles empty, zero-size and out-of-range pages and rejects invalid indices", () => {
  for (const [count, size, cursor] of [
    [0, 9, 0],
    [5, 0, 2],
    [5, 9, 99],
  ]) {
    const lazy = decodeLookupTableRecord(fixture(count, size, cursor).bytes);
    expect(lazy.visible()).toEqual({ candidates: [], labels: [] });
    expect(lazy.page(Number.MAX_SAFE_INTEGER)).toEqual({ candidates: [], labels: [] });
    for (const page of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => lazy.page(page)).toThrow(RangeError);
  }
});

it("rejects wrong kind, flags, truncated record and nonzero record padding eagerly", () => {
  for (const mutate of [
    (bytes: Uint8Array) => new DataView(bytes.buffer).setUint16(8, 9, true),
    (bytes: Uint8Array) => new DataView(bytes.buffer).setUint16(10, 2, true),
  ]) {
    const { bytes } = fixture();
    mutate(bytes);
    expect(() => decodeLookupTableRecord(bytes)).toThrow();
  }
  const { bytes } = fixture();
  expect(() => decodeLookupTableRecord(bytes.subarray(0, bytes.length - 1))).toThrow();
  const length = new DataView(bytes.buffer).getUint32(12, true);
  expect(bytes.length).toBeGreaterThan(16 + length);
  bytes[bytes.length - 1] = 1;
  expect(() => decodeLookupTableRecord(bytes)).toThrow();
});

it("array boundaries validate framing without reading element payloads", () => {
  const bytes = encodeValue("av", {
    _tag: "a",
    items: [
      { _tag: "v", type: "s", value: { _tag: "s", value: "first" } },
      { _tag: "v", type: "s", value: { _tag: "s", value: "second" } },
    ],
  });
  bytes[0] = 0xff;
  const boundaries = decodeArrayBoundaries("av", bytes);
  expect(boundaries).toHaveLength(2);
  expect(boundaries[0]!.start).toBe(0);
  bytes[bytes.length - 2] = 0xff;
  expect(() => decodeArrayBoundaries("av", bytes)).toThrow();
});

it("defers strict IBusText serializable validation and label payloads", () => {
  const { bytes } = fixture();
  const position = Buffer.from(bytes).indexOf(Buffer.from("candidate-19-한글"));
  const name = Buffer.from(bytes).lastIndexOf("IBusText", position);
  bytes[name] = 88;
  const lazy = decodeLookupTableRecord(bytes);
  expect(lazy.page(0).candidates).toHaveLength(9);
  expect(() => lazy.page(2)).toThrow("IBusText");
  const labelBytes = fixture().bytes;
  labelBytes[Buffer.from(labelBytes).indexOf("label-15")] = 0xff;
  expect(decodeLookupTableRecord(labelBytes).visible().labels).toHaveLength(9);
  const requestedLabels = fixture(20, 16).bytes;
  requestedLabels[Buffer.from(requestedLabels).indexOf("label-15")] = 0xff;
  const withInvalidLabel = decodeLookupTableRecord(requestedLabels);
  expect(() => withInvalidLabel.page(0)).toThrow();
});

it("validates fixed boolean fields and the serializable table name eagerly", () => {
  const { bytes } = fixture();
  const name = Buffer.from(bytes).indexOf("IBusLookupTable");
  bytes[name] = 88;
  expect(() => decodeLookupTableRecord(bytes)).toThrow("IBusLookupTable");
  const invalid = fixture().bytes;
  // The fixed boolean after the table variant is the last payload data byte before its tuple offset.
  const payloadLength = new DataView(invalid.buffer).getUint32(12, true);
  const width = payloadLength > 255 ? 2 : 1;
  invalid[16 + payloadLength - width - 1] = 2;
  expect(() => decodeLookupTableRecord(invalid)).toThrow();
});

it("defers an invisible candidate's malformed inner tuple framing", () => {
  const { bytes, tree } = fixture();
  if (tree._tag !== "()" || tree.items[0]?._tag !== "v" || tree.items[0].value._tag !== "()")
    throw new Error("wrong fixture");
  const candidates = tree.items[0].value.items[7]!;
  if (candidates._tag !== "a") throw new Error("wrong candidates");
  const candidate = encodeValue("v", candidates.items[19]!);
  const start = Buffer.from(bytes).indexOf(candidate);
  const suffixBytes = 1 + signatureOf(IBusText).length;
  bytes[start + candidate.length - suffixBytes - 1] = 0xff;
  expect(() => decodeRecord(bytes)).toThrow();
  const lazy = decodeLookupTableRecord(bytes);
  expect(lazy.visible().candidates).toHaveLength(9);
  expect(() => lazy.page(2)).toThrow();
});
