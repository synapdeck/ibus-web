// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect";
import { GVariantBytes } from "../gvariant/schema.ts";
import { ProtocolError } from "../gvariant/type.ts";
import { fromTree, signatureOf, toTree } from "../ibus/walk.ts";
import { RECORD_ALIGNMENT, RECORD_CONTINUATION } from "./framing.ts";
import { Request, requestKinds } from "./requests.ts";
import { OutputRecord, recordKinds } from "./records.ts";

function payloadCodecs<Type, Encoded>(schemas: readonly Schema.Codec<Type, Encoded>[]) {
  const codecs = new Map<number, Schema.Codec<Type, Uint8Array>>();
  for (const schema of schemas) {
    const kind = schema.ast.annotations!.kind!;
    const signature = signatureOf(schema);
    const decodeTree = fromTree(schema);
    const codec = GVariantBytes(signature).pipe(
      Schema.decodeTo(schema, {
        decode: SchemaGetter.transformEffect((tree, options) =>
          Effect.try({
            try: () => decodeTree(tree),
            catch: (error) =>
              new SchemaIssue.InvalidValue(
                { message: `GVariant ${signature}: ${error instanceof ProtocolError ? error.message : String(error)}` },
                tree,
                options,
              ),
          }),
        ),
        encode: SchemaGetter.transform(toTree(schema)),
      }),
    );
    codecs.set(kind, codec);
  }
  return codecs;
}

const requestCodecs = payloadCodecs<Request, typeof Request.Encoded>(Request.members);
const recordCodecs = payloadCodecs<OutputRecord, typeof OutputRecord.Encoded>(OutputRecord.members);
const crashedKind = recordKinds.get("Crashed");
const requestEncoders = new Map([...requestCodecs].map(([kind, codec]) => [kind, Schema.encodeSync(codec)]));
const recordDecoders = new Map([...recordCodecs].map(([kind, codec]) => [kind, Schema.decodeUnknownSync(codec)]));

export function encodeRequest(ic: number, request: Request): Uint8Array {
  if (!Number.isInteger(ic) || ic < 0 || ic > 0xffffffff) {
    throw new ProtocolError({ message: "Input context must be an unsigned 32-bit integer" });
  }
  const kind = requestKinds.get(request._tag);
  const encode = kind === undefined ? undefined : requestEncoders.get(kind);
  if (kind === undefined || encode === undefined) {
    throw new ProtocolError({ message: `Unknown request kind: ${request._tag}` });
  }
  const payload = encode(request);
  const bytes = new Uint8Array(8 + payload.length);
  const header = new DataView(bytes.buffer);
  header.setUint16(0, kind, true);
  header.setUint16(2, 0, true);
  header.setUint32(4, ic, true);
  bytes.set(payload, 8);
  return bytes;
}

export interface DecodedRecord<Record = OutputRecord> {
  readonly seq: number;
  readonly ic: number;
  readonly flags: number;
  readonly size: number;
  readonly record: Record;
}

/** Validates the complete record envelope before any payload is decoded. */
export function readRecordEnvelope(bytes: Uint8Array, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length - 16) {
    throw new ProtocolError({ message: "Record offset is invalid or the header is truncated" });
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset + offset, 16);
  const seq = header.getUint32(0, true);
  const ic = header.getUint32(4, true);
  const kind = header.getUint16(8, true);
  const flags = header.getUint16(10, true);
  const length = header.getUint32(12, true);
  if ((flags & RECORD_CONTINUATION) !== 0) {
    throw new ProtocolError({ message: "Continuation records must be reassembled before decoding" });
  }
  if (flags !== 0) {
    throw new ProtocolError({ message: `Unknown record flags: 0x${flags.toString(16).padStart(4, "0")}` });
  }
  const decode = recordDecoders.get(kind);
  if (decode === undefined) {
    throw new ProtocolError({ message: `Unknown record payload kind: ${kind}` });
  }
  // seq 0 marks a host-written record, so a Crashed from anywhere else is forged or corrupt.
  if (kind === crashedKind && (seq !== 0 || ic !== 0)) {
    throw new ProtocolError({ message: "Crashed records must carry seq 0 and ic 0" });
  }
  const size = Math.ceil((16 + length) / RECORD_ALIGNMENT) * RECORD_ALIGNMENT;
  if (size > bytes.length - offset) {
    throw new ProtocolError({ message: "Record payload or padding extends beyond the buffer" });
  }
  const payloadEnd = offset + 16 + length;
  for (let index = payloadEnd; index < offset + size; index++) {
    if (bytes[index] !== 0) {
      throw new ProtocolError({ message: `Nonzero record padding at byte ${index}` });
    }
  }
  return { seq, ic, flags, size, kind, payload: bytes.subarray(offset + 16, payloadEnd) };
}

/**
 * Decodes the record at `offset`. Framing errors (a truncated header, an unknown kind, flags it
 * cannot handle, padding, a Crashed record the host didn't write) throw `ProtocolError`; a payload
 * that doesn't match its kind's schema throws `SchemaError`.
 */
export function decodeRecord(bytes: Uint8Array, offset = 0): DecodedRecord {
  const { seq, ic, flags, size, kind, payload } = readRecordEnvelope(bytes, offset);
  return { seq, ic, flags, size, record: recordDecoders.get(kind)!(payload) };
}
