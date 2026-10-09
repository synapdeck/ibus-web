// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it, test } from "@effect/vitest";
import { Schema } from "effect";
import {
  CrashReason,
  CreateEngineFailed,
  ProtocolError,
  Request,
  OutputRecord,
  decodeValue,
  encodeValue,
  encodeRequest,
  decodeRecord,
  requestKinds,
  recordKinds,
  signatureOf,
} from "../../src/index.ts";
import { fromTree, toTree } from "../../src/ibus/walk.ts";

const encodeRequestFields = Schema.encodeSync(Request);
const decodeRequestFields = Schema.decodeUnknownSync(Request);
const encodeRecordFields = Schema.encodeSync(OutputRecord);

function encodeRecordForTest(record: OutputRecord): Uint8Array {
  const schema = OutputRecord.members.find((member) => member.name === record._tag)!;
  const payload = encodeValue(signatureOf(schema), toTree(schema)(encodeRecordFields(record)));
  const bytes = new Uint8Array(Math.ceil((16 + payload.length) / 8) * 8);
  const header = new DataView(bytes.buffer);
  // Only the host writes Crashed, always with seq and ic zero.
  const fromHost = record._tag === "Crashed";
  header.setUint32(0, fromHost ? 0 : 0xffffffff, true);
  header.setUint32(4, fromHost ? 0 : 7, true);
  header.setUint16(8, recordKinds.get(record._tag)!, true);
  header.setUint32(12, payload.length, true);
  bytes.set(payload, 16);
  return bytes;
}

it.prop(
  "requests preserve encoded fields through their wire payload",
  [Request],
  ([request]) => {
    const bytes = encodeRequest(7, request);
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(header.getUint16(0, true)).toBe(requestKinds.get(request._tag));
    expect(header.getUint16(2, true)).toBe(0);
    expect(header.getUint32(4, true)).toBe(7);
    const schema = Request.members.find((member) => member.name === request._tag)!;
    const tree = decodeValue(signatureOf(schema), bytes.subarray(8));
    const decoded = decodeRequestFields(fromTree(schema)(tree));
    expect(encodeRequestFields(decoded)).toEqual(encodeRequestFields(request));
    expect(encodeRequest(7, decoded)).toEqual(bytes);
  },
  { arbitrary: { runs: 200, seed: 41 } },
);

it.prop(
  "records preserve encoded fields through their framing and payload",
  [OutputRecord],
  ([record]) => {
    const bytes = encodeRecordForTest(record);
    const decoded = decodeRecord(bytes);
    const fromHost = record._tag === "Crashed";
    expect(decoded).toMatchObject({
      seq: fromHost ? 0 : 0xffffffff,
      ic: fromHost ? 0 : 7,
      flags: 0,
      size: bytes.length,
    });
    expect(encodeRecordFields(decoded.record)).toEqual(encodeRecordFields(record));
    expect(encodeRecordForTest(decoded.record)).toEqual(bytes);
  },
  { arbitrary: { runs: 200, seed: 42 } },
);

function crashedRecord(reason: number, seq = 0, ic = 0): Uint8Array {
  const payload = encodeValue("(us)", {
    _tag: "()",
    items: [
      { _tag: "u", value: reason },
      { _tag: "s", value: "boom" },
    ],
  });
  const bytes = new Uint8Array(Math.ceil((16 + payload.length) / 8) * 8);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, seq, true);
  header.setUint32(4, ic, true);
  header.setUint16(8, recordKinds.get("Crashed")!, true);
  header.setUint32(12, payload.length, true);
  bytes.set(payload, 16);
  return bytes;
}

test.each(Object.values(CrashReason))("decodes Crashed with reason %i", (reason) => {
  expect(decodeRecord(crashedRecord(reason)).record).toMatchObject({ _tag: "Crashed", reason, message: "boom" });
});

test.each([0, 6, 9, 0xffffffff])("rejects Crashed with unknown reason %i", (reason) => {
  expect(() => decodeRecord(crashedRecord(reason))).toThrow();
});

test.each([
  [1, 0],
  [0, 1],
  [0xffffffff, 7],
])("rejects Crashed from seq %i and ic %i", (seq, ic) => {
  expect(() => decodeRecord(crashedRecord(CrashReason.trap, seq, ic))).toThrow(ProtocolError);
});

test("decodes CreateEngineFailed's reason on its input context", () => {
  const message = "latex.table:9: line 9 has no tab";
  expect(decodeRecord(encodeRecordForTest(new CreateEngineFailed({ message })))).toMatchObject({
    ic: 7,
    record: { _tag: "CreateEngineFailed", message },
  });
});
