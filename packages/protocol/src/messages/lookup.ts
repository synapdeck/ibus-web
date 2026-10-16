// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";
import { decodeValueRange, decodeValueWithDeferredArrays, type ElementBoundary } from "../gvariant/decode.ts";
import { CodecError } from "../gvariant/type.ts";
import { IBusText } from "../ibus/types.ts";
import { fromTree, signatureOf } from "../ibus/walk.ts";
import { decodeRecord, readRecordEnvelope, type DecodedRecord } from "./codec.ts";
import { UpdateLookupTable, recordKinds, type OutputRecord } from "./records.ts";

export interface LookupPage {
  readonly candidates: IBusText[];
  readonly labels: IBusText[];
}
export interface LazyLookupTable {
  readonly pageSize: number;
  readonly cursorPos: number;
  readonly cursorVisible: boolean;
  readonly round: boolean;
  readonly orientation: number;
  readonly count: number;
  visible(): LookupPage;
  /** Zero-based page number. Labels name positions within each page. */
  page(index: number): LookupPage;
}
export type LazyOutputRecord =
  | Exclude<OutputRecord, UpdateLookupTable>
  | {
      readonly _tag: "UpdateLookupTable";
      readonly table: LazyLookupTable;
      readonly visible: boolean;
    };
export type DecodedLazyRecord = DecodedRecord<LazyOutputRecord>;
const lookupKind = recordKinds.get("UpdateLookupTable")!;
const lookupSignature = signatureOf(UpdateLookupTable);
const lookupFromTree = fromTree(UpdateLookupTable);
const decodeLookup = Schema.decodeUnknownSync(UpdateLookupTable);
const textSignature = signatureOf(IBusText);
const textFromTree = fromTree(IBusText);
const decodeText = Schema.decodeUnknownSync(IBusText);

function lookupPayload(payload: Uint8Array): Extract<LazyOutputRecord, { _tag: "UpdateLookupTable" }> {
  const arrays: (readonly ElementBoundary[])[] = [];
  const tree = decodeValueWithDeferredArrays(lookupSignature, payload, (element, depth, boundaries) => {
    // The record tuple contains a table variant, whose tuple owns the two av fields.
    if (depth !== 3 || element._tag !== "v") return false;
    arrays.push(boundaries);
    return true;
  });
  const decoded = decodeLookup(lookupFromTree(tree));
  if (arrays.length !== 2) throw new CodecError({ message: "Expected candidate and label arrays" });
  const [candidates, labels] = arrays as [readonly ElementBoundary[], readonly ElementBoundary[]];
  const { pageSize, cursorPos, cursorVisible, round, orientation } = decoded.table;
  const read = ({ start, end }: ElementBoundary): IBusText => {
    const variant = decodeValueRange("v", payload, start, end, 4);
    if (variant._tag !== "v" || variant.type !== textSignature)
      throw new CodecError({ message: `Expected IBusText variant type ${textSignature}` });
    return decodeText(textFromTree(variant.value));
  };
  const table: LazyLookupTable = {
    pageSize,
    cursorPos,
    cursorVisible,
    round,
    orientation,
    count: candidates.length,
    visible: () => table.page(pageSize === 0 ? 0 : Math.floor(cursorPos / pageSize)),
    page(index) {
      if (!Number.isSafeInteger(index) || index < 0)
        throw new RangeError("Page index must be a nonnegative safe integer");
      if (pageSize === 0 || index >= Math.ceil(candidates.length / pageSize)) return { candidates: [], labels: [] };
      const start = index * pageSize;
      return {
        candidates: candidates.slice(start, start + pageSize).map(read),
        labels: labels.slice(0, pageSize).map(read),
      };
    },
  };
  return { _tag: "UpdateLookupTable", table, visible: decoded.visible };
}

/** Owns a snapshot so pages survive caller mutation and output ring reuse. */
export function decodeLookupTableRecord(bytes: Uint8Array, offset = 0): LazyLookupTable {
  const envelope = readRecordEnvelope(bytes, offset);
  if (envelope.kind !== lookupKind) throw new CodecError({ message: "Expected UpdateLookupTable record" });
  return lookupPayload(new Uint8Array(envelope.payload)).table;
}

/** Decodes all records strictly, deferring lookup candidates and labels until a page is requested. */
export function decodeRecordLazy(bytes: Uint8Array, offset = 0): DecodedLazyRecord {
  const { seq, ic, flags, size, kind, payload } = readRecordEnvelope(bytes, offset);
  if (kind !== lookupKind)
    return decodeRecord(bytes, offset) as DecodedRecord<Exclude<OutputRecord, UpdateLookupTable>>;
  return { seq, ic, flags, size, record: lookupPayload(new Uint8Array(payload)) };
}
