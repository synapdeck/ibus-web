// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it, test } from "@effect/vitest";
import { Schema } from "effect";
import {
  CodecError,
  CommitText,
  Crashed,
  FocusIn,
  IBusAttrList,
  IBusText,
  OutputRecord,
  Request,
  SetCapabilities,
  decodeRecord,
  decodeRequest,
  encodeRecord,
  encodeRequest,
  recordKinds,
} from "../../src/index.ts";

const encodeRequestFields = Schema.encodeSync(Request);
const encodeRecordFields = Schema.encodeSync(OutputRecord);

const commit = new CommitText({
  text: IBusText.make({ attachments: {}, text: "한글", attrs: IBusAttrList.make({ attachments: {}, attributes: [] }) }),
});

it.prop(
  "requests round trip through encodeRequest and decodeRequest",
  [Request],
  ([request]) => {
    const bytes = encodeRequest(7, request);
    const decoded = decodeRequest(bytes);
    expect(decoded.ic).toBe(7);
    expect(encodeRequestFields(decoded.request)).toEqual(encodeRequestFields(request));
    expect(encodeRequest(decoded.ic, decoded.request)).toEqual(bytes);
  },
  { arbitrary: { runs: 200, seed: 51 } },
);

it.prop(
  "records round trip through encodeRecord and decodeRecord",
  [OutputRecord],
  ([record]) => {
    const fromHost = record._tag === "Crashed";
    const seq = fromHost ? 0 : 0xffffffff;
    const ic = fromHost ? 0 : 7;
    const bytes = encodeRecord(seq, ic, record);
    const decoded = decodeRecord(bytes);
    expect(decoded).toMatchObject({ seq, ic, flags: 0, size: bytes.length });
    expect(encodeRecordFields(decoded.record)).toEqual(encodeRecordFields(record));
    expect(encodeRecord(seq, ic, decoded.record)).toEqual(bytes);
  },
  { arbitrary: { runs: 200, seed: 52 } },
);

test("encodeRecord frames a sixteen-byte header and zero padding to eight bytes", () => {
  const bytes = encodeRecord(3, 9, commit);
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = header.getUint32(12, true);
  expect(header.getUint32(0, true)).toBe(3);
  expect(header.getUint32(4, true)).toBe(9);
  expect(header.getUint16(8, true)).toBe(recordKinds.get("CommitText"));
  expect(header.getUint16(10, true)).toBe(0);
  expect(bytes.length).toBe(Math.ceil((16 + length) / 8) * 8);
  expect(bytes.length).toBeGreaterThan(16 + length);
  expect(bytes.subarray(16 + length).every((byte) => byte === 0)).toBe(true);
});

test.each([-1, 1.5, 0x100000000, Number.NaN])("encodeRecord refuses seq %s", (seq) => {
  expect(() => encodeRecord(seq, 1, commit)).toThrow(CodecError);
});

test.each([-1, 1.5, 0x100000000, Number.NaN])("encodeRecord refuses ic %s", (ic) => {
  expect(() => encodeRecord(1, ic, commit)).toThrow(CodecError);
});

test("encodeRecord refuses a Crashed record on a sequence or context other than zero", () => {
  const crashed = new Crashed({ reason: 1, message: "boom" });
  expect(() => encodeRecord(1, 0, crashed)).toThrow(CodecError);
  expect(() => encodeRecord(0, 1, crashed)).toThrow(CodecError);
  expect(decodeRecord(encodeRecord(0, 0, crashed)).record).toMatchObject({ _tag: "Crashed", reason: 1 });
});

test("encodeRecord refuses a record whose kind is unknown", () => {
  expect(() => encodeRecord(1, 1, { _tag: "Nope" } as unknown as OutputRecord)).toThrow(CodecError);
});

test("decodeRequest refuses a header that is truncated or has no payload", () => {
  const bytes = encodeRequest(1, new FocusIn({}));
  expect(() => decodeRequest(bytes.subarray(0, 7))).toThrow(CodecError);
  expect(() => decodeRequest(bytes.subarray(0, 8))).toThrow(CodecError);
  expect(() => decodeRequest(new Uint8Array(0))).toThrow(CodecError);
});

test("decodeRequest refuses nonzero flags", () => {
  const bytes = encodeRequest(1, new FocusIn({}));
  new DataView(bytes.buffer).setUint16(2, 1, true);
  expect(() => decodeRequest(bytes)).toThrow(CodecError);
});

test("decodeRequest refuses an unknown kind, including the test range", () => {
  for (const kind of [0, 0xfffe, 0xff00]) {
    const bytes = encodeRequest(1, new FocusIn({}));
    new DataView(bytes.buffer).setUint16(0, kind, true);
    expect(() => decodeRequest(bytes), String(kind)).toThrow(CodecError);
  }
});

test("decodeRequest decodes a view into a larger buffer", () => {
  const request = new FocusIn({});
  const bytes = encodeRequest(5, request);
  const backing = new Uint8Array(bytes.length + 6);
  backing.set(bytes, 3);
  expect(decodeRequest(backing.subarray(3, 3 + bytes.length))).toMatchObject({ ic: 5, request: { _tag: "FocusIn" } });
});

test("decodeRequest refuses a payload that does not match its kind", () => {
  const bytes = encodeRequest(1, new FocusIn({}));
  const kindOfSetCapabilities = encodeRequest(1, new SetCapabilities({ capabilities: 1 }));
  new DataView(bytes.buffer).setUint16(0, new DataView(kindOfSetCapabilities.buffer).getUint16(0, true), true);
  expect(() => decodeRequest(bytes)).toThrow();
});
