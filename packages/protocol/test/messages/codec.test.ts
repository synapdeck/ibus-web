// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
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
  header.setUint32(0, 0xffffffff, true);
  header.setUint32(4, 7, true);
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
    expect(decoded).toMatchObject({ seq: 0xffffffff, ic: 7, flags: 0, size: bytes.length });
    expect(encodeRecordFields(decoded.record)).toEqual(encodeRecordFields(record));
    expect(encodeRecordForTest(decoded.record)).toEqual(bytes);
  },
  { arbitrary: { runs: 200, seed: 42 } },
);
