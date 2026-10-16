// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "@effect/vitest";
import { Schema } from "effect";
import {
  CommitText,
  FocusIn,
  ProcessKeyEvent,
  GVariantDecodeError,
  CodecError,
  Request,
  decodeRecord,
  decodeValue,
  encodeRequest,
  encodeValue,
  framing,
  RECORD_CONTINUATION,
  signatureOf,
  type GVariantValue,
} from "../../src/index.ts";

// The runtime treats a request of the header alone as malformed, which holds only while no
// request's payload can be empty.
test.each(Object.keys(Request.cases))("%s has no empty payload", (name) => {
  const signature = signatureOf(Request.cases[name as keyof typeof Request.cases]);
  expect(() => decodeValue(signature, new Uint8Array())).toThrow(GVariantDecodeError);
});

function commitTextRecord(
  name = "IBusText",
  attachments: readonly GVariantValue[] = [],
  text: GVariantValue = { _tag: "s", value: "한" },
): Uint8Array {
  return frame({
    _tag: "()",
    items: [
      {
        _tag: "v",
        type: "(sa{sv}sv)",
        value: {
          _tag: "()",
          items: [
            { _tag: "s", value: name },
            { _tag: "a", items: attachments },
            text,
            {
              _tag: "v",
              type: "(sa{sv}av)",
              value: {
                _tag: "()",
                items: [
                  { _tag: "s", value: "IBusAttrList" },
                  { _tag: "a", items: [] },
                  { _tag: "a", items: [] },
                ],
              },
            },
          ],
        },
      },
    ],
  });
}

function frame(tree: GVariantValue): Uint8Array {
  const payload = encodeValue("(v)", tree);
  const bytes = new Uint8Array(Math.ceil((16 + payload.length) / 8) * 8);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 3, true);
  header.setUint32(4, 1, true);
  header.setUint16(8, 1, true);
  header.setUint32(12, payload.length, true);
  bytes.set(payload, 16);
  return bytes;
}

test("describes the headers in their wire order", () => {
  expect(framing.request.map(({ name, width }) => [name, width])).toEqual([
    ["kind", 2],
    ["flags", 2],
    ["ic", 4],
  ]);
  expect(framing.record.map(({ name, width }) => [name, width])).toEqual([
    ["seq", 4],
    ["ic", 4],
    ["kind", 2],
    ["flags", 2],
    ["len", 4],
  ]);
});

test("encodes FocusIn with its header and the empty tuple byte", () => {
  expect(encodeRequest(7, new FocusIn({}))).toEqual(Uint8Array.of(0x11, 0, 0, 0, 7, 0, 0, 0, 0));
});

test("encodes ProcessKeyEvent in little endian without record padding", () => {
  const bytes = encodeRequest(1, new ProcessKeyEvent({ keyval: 0x61, keycode: 30, state: 0 }));
  expect(bytes).toEqual(Uint8Array.of(16, 0, 0, 0, 1, 0, 0, 0, 0x61, 0, 0, 0, 30, 0, 0, 0, 0, 0, 0, 0));
});

test("decodes a hand-framed CommitText with Korean text", () => {
  const bytes = commitTextRecord();
  const decoded = decodeRecord(bytes);
  expect(decoded).toMatchObject({ seq: 3, ic: 1, flags: 0, size: bytes.length });
  expect(decoded.record).toBeInstanceOf(CommitText);
  expect(decoded.record).toMatchObject({ _tag: "CommitText", text: { text: "한" } });
  expect(decoded.size % 8).toBe(0);
  const payloadLength = new DataView(bytes.buffer).getUint32(12, true);
  const padding = bytes.subarray(16 + payloadLength);
  expect(padding.length).toBeGreaterThan(0);
  expect([...padding]).toEqual(Array(padding.length).fill(0));
});

test("reads offsets relative to a byte view and returns the padded record size", () => {
  const record = commitTextRecord();
  const storage = new Uint8Array(record.length * 2 + 5);
  storage.set(record, 5);
  storage.set(record, 5 + record.length);
  const view = storage.subarray(3);
  expect(decodeRecord(view, 2).record).toEqual(decodeRecord(view, 2 + record.length).record);
  expect(decodeRecord(view, 2).size).toBe(record.length);
});

test("rejects nonzero record padding", () => {
  const bytes = commitTextRecord();
  bytes[bytes.length - 1] = 1;
  expect(() => decodeRecord(bytes)).toThrow(CodecError);
});

test("rejects payload lengths beyond the byte view", () => {
  const bytes = commitTextRecord();
  new DataView(bytes.buffer).setUint32(12, bytes.length, true);
  expect(() => decodeRecord(bytes)).toThrow(CodecError);
});

test.each([0xffff, 0])("rejects record kind %s without a payload schema", (kind) => {
  const bytes = commitTextRecord();
  new DataView(bytes.buffer).setUint16(8, kind, true);
  expect(() => decodeRecord(bytes)).toThrow(CodecError);
});

test("rejects continuation records until the ring reader reassembles them", () => {
  const bytes = commitTextRecord();
  new DataView(bytes.buffer).setUint16(10, RECORD_CONTINUATION, true);
  expect(() => decodeRecord(bytes)).toThrow(CodecError);
});

test("rejects record flags it does not define", () => {
  const bytes = commitTextRecord();
  new DataView(bytes.buffer).setUint16(10, 0x0002, true);
  expect(() => decodeRecord(bytes)).toThrow(CodecError);
  expect(() => decodeRecord(bytes)).toThrow(/flags/);
});

function expectPayloadError(bytes: Uint8Array, message: RegExp) {
  let error: unknown;
  try {
    decodeRecord(bytes);
  } catch (caught) {
    error = caught;
  }
  expect(Schema.isSchemaError(error)).toBe(true);
  expect(String((error as Error).message)).toMatch(message);
}

test("reports a variant holding the wrong type as a payload error", () => {
  expectPayloadError(
    frame({ _tag: "()", items: [{ _tag: "v", type: "s", value: { _tag: "s", value: "한" } }] }),
    /IBusText variant type/,
  );
});

test("reports an unexpected serializable name as a payload error", () => {
  expectPayloadError(commitTextRecord("IBusFoo"), /serializable name IBusText/);
});

test("reports an attachment without its inner variant as a payload error", () => {
  const attachment: GVariantValue = {
    _tag: "{}",
    key: { _tag: "s", value: "source" },
    value: { _tag: "v", type: "s", value: { _tag: "s", value: "fixture" } },
  };
  expectPayloadError(commitTextRecord("IBusText", [attachment]), /inner variant/);
});

test.each([-1, 0.5, NaN, Infinity])("rejects invalid record offset %s", (offset) => {
  expect(() => decodeRecord(commitTextRecord(), offset)).toThrow(CodecError);
});

test("rejects truncated headers and missing padding", () => {
  const bytes = commitTextRecord();
  expect(() => decodeRecord(bytes.subarray(0, 15))).toThrow(CodecError);
  expect(() => decodeRecord(bytes.subarray(0, bytes.length - 1))).toThrow(CodecError);
});

test.each([-1, 0.5, 2 ** 32, NaN])("rejects invalid input context %s", (ic) => {
  expect(() => encodeRequest(ic, new FocusIn({}))).toThrow(CodecError);
});
