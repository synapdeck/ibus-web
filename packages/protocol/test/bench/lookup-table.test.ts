// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { cpus, release } from "node:os";
import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  IBusAttribute,
  IBusAttrList,
  IBusText,
  IBusLookupTable,
  UpdateLookupTable,
  decodeRecord,
  decodeValue,
  encodeValue,
  recordKinds,
  signatureOf,
} from "../../src/index.ts";
import { fromTree, toTree } from "../../src/ibus/walk.ts";

function textWithAttribute(text: string): IBusText {
  return IBusText.make({
    attachments: {},
    text,
    attrs: IBusAttrList.make({
      attachments: {},
      attributes: [IBusAttribute.make({ attachments: {}, type: 1, value: 1, startIndex: 0, endIndex: text.length })],
    }),
  });
}

function measure(label: string, decode: () => unknown) {
  for (let index = 0; index < 50; index++) decode();
  const samples: number[] = [];
  for (let index = 0; index < 500; index++) {
    const start = performance.now();
    decode();
    samples.push(performance.now() - start);
  }
  const sorted = samples.toSorted((left, right) => left - right);
  const medianMs = (sorted[249]! + sorted[250]!) / 2;
  const p99Ms = sorted[494]!;
  console.log(JSON.stringify({ label, medianMs, p99Ms, samplesMs: samples }));
}

it("times decoding a framed 500-candidate lookup table", () => {
  const words = ["한글", "한국어", "대한민국"];
  const record = new UpdateLookupTable({
    table: IBusLookupTable.make({
      attachments: {},
      pageSize: 9,
      cursorPos: 0,
      cursorVisible: true,
      round: false,
      orientation: 0,
      candidates: Array.from({ length: 500 }, (_, index) => textWithAttribute(words[index % words.length]!)),
      labels: Array.from({ length: 9 }, (_, index) => textWithAttribute(String(index + 1))),
    }),
    visible: true,
  });
  const signature = signatureOf(UpdateLookupTable);
  const payload = encodeValue(signature, toTree(UpdateLookupTable)(Schema.encodeSync(UpdateLookupTable)(record)));
  const framed = new Uint8Array(Math.ceil((16 + payload.length) / 8) * 8);
  const header = new DataView(framed.buffer);
  header.setUint32(0, 1, true);
  header.setUint32(4, 1, true);
  header.setUint16(8, recordKinds.get("UpdateLookupTable")!, true);
  header.setUint32(12, payload.length, true);
  framed.set(payload, 16);
  expect(decodeRecord(framed).record).toEqual(record);
  console.log(
    JSON.stringify({
      recordBytes: framed.length,
      payloadBytes: payload.length,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      kernel: release(),
      cpu: cpus()[0]?.model,
    }),
  );
  measure("framed decode", () => decodeRecord(framed));
  measure("bytes to tree", () => decodeValue(signature, payload));
  const tree = decodeValue(signature, payload);
  const fieldsFromTree = fromTree(UpdateLookupTable);
  const decodeFields = Schema.decodeUnknownSync(UpdateLookupTable);
  measure("tree to schemas", () => decodeFields(fieldsFromTree(tree)));
});
