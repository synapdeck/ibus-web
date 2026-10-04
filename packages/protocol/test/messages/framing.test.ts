// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it } from "@effect/vitest";
import {
  CommitText,
  FocusIn,
  ProcessKeyEvent,
  ProtocolError,
  decodeRecord,
  encodeRequest,
  encodeValue,
  framing,
  RECORD_CONTINUATION,
} from "../../src/index.ts";

function commitTextRecord(): Uint8Array {
  const payload = encodeValue("(v)", {
    _tag: "()",
    items: [
      {
        _tag: "v",
        type: "(sa{sv}sv)",
        value: {
          _tag: "()",
          items: [
            { _tag: "s", value: "IBusText" },
            { _tag: "a", items: [] },
            { _tag: "s", value: "한" },
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
  const bytes = new Uint8Array(Math.ceil((16 + payload.length) / 8) * 8);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 3, true);
  header.setUint32(4, 1, true);
  header.setUint16(8, 1, true);
  header.setUint32(12, payload.length, true);
  bytes.set(payload, 16);
  return bytes;
}

it("describes the headers in their wire order", () => {
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

it("encodes FocusIn with its header and the empty tuple byte", () => {
  expect(encodeRequest(7, new FocusIn({}))).toEqual(Uint8Array.of(0x11, 0, 0, 0, 7, 0, 0, 0, 0));
});

it("encodes ProcessKeyEvent in little endian without record padding", () => {
  const bytes = encodeRequest(1, new ProcessKeyEvent({ keyval: 0x61, keycode: 30, state: 0 }));
  expect(bytes).toEqual(Uint8Array.of(16, 0, 0, 0, 1, 0, 0, 0, 0x61, 0, 0, 0, 30, 0, 0, 0, 0, 0, 0, 0));
});

it("decodes a hand-framed CommitText with Korean text", () => {
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

it("reads offsets relative to a byte view and returns the padded record size", () => {
  const record = commitTextRecord();
  const storage = new Uint8Array(record.length * 2 + 5);
  storage.set(record, 5);
  storage.set(record, 5 + record.length);
  const view = storage.subarray(3);
  expect(decodeRecord(view, 2).record).toEqual(decodeRecord(view, 2 + record.length).record);
  expect(decodeRecord(view, 2).size).toBe(record.length);
});

it("rejects nonzero record padding", () => {
  const bytes = commitTextRecord();
  bytes[bytes.length - 1] = 1;
  expect(() => decodeRecord(bytes)).toThrow(ProtocolError);
});

it("rejects payload lengths beyond the byte view", () => {
  const bytes = commitTextRecord();
  new DataView(bytes.buffer).setUint32(12, bytes.length, true);
  expect(() => decodeRecord(bytes)).toThrow(ProtocolError);
});

it.each([0xffff, 34])("rejects record kind %s without a payload schema", (kind) => {
  const bytes = commitTextRecord();
  new DataView(bytes.buffer).setUint16(8, kind, true);
  expect(() => decodeRecord(bytes)).toThrow(ProtocolError);
});

it("rejects continuation records until the ring reader reassembles them", () => {
  const bytes = commitTextRecord();
  new DataView(bytes.buffer).setUint16(10, RECORD_CONTINUATION, true);
  expect(() => decodeRecord(bytes)).toThrow(ProtocolError);
});

it.each([-1, 0.5, NaN, Infinity])("rejects invalid record offset %s", (offset) => {
  expect(() => decodeRecord(commitTextRecord(), offset)).toThrow(ProtocolError);
});

it("rejects truncated headers and missing padding", () => {
  const bytes = commitTextRecord();
  expect(() => decodeRecord(bytes.subarray(0, 15))).toThrow(ProtocolError);
  expect(() => decodeRecord(bytes.subarray(0, bytes.length - 1))).toThrow(ProtocolError);
});

it.each([-1, 0.5, 2 ** 32, NaN])("rejects invalid input context %s", (ic) => {
  expect(() => encodeRequest(ic, new FocusIn({}))).toThrow(ProtocolError);
});
