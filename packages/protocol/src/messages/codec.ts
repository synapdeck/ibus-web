// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect";
import { GVariantBytes } from "../gvariant/schema.ts";
import { CodecError } from "../gvariant/type.ts";
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
                { message: `GVariant ${signature}: ${error instanceof CodecError ? error.message : String(error)}` },
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
const requestDecoders = new Map([...requestCodecs].map(([kind, codec]) => [kind, Schema.decodeUnknownSync(codec)]));
const recordEncoders = new Map([...recordCodecs].map(([kind, codec]) => [kind, Schema.encodeSync(codec)]));

export function encodeRequest(ic: number, request: Request): Uint8Array {
  if (!Number.isInteger(ic) || ic < 0 || ic > 0xffffffff) {
    throw new CodecError({ message: "Input context must be an unsigned 32-bit integer" });
  }
  const kind = requestKinds.get(request._tag);
  const encode = kind === undefined ? undefined : requestEncoders.get(kind);
  if (kind === undefined || encode === undefined) {
    throw new CodecError({ message: `Unknown request kind: ${request._tag}` });
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

export interface DecodedRequest {
  readonly ic: number;
  readonly request: Request;
}

/**
 * Decodes a request: an eight-byte header and a payload. Framing faults (a truncated header, a
 * header with no payload, nonzero flags, an unknown kind) throw `CodecError`; a payload that
 * doesn't match its kind's schema throws `SchemaError`.
 */
export function decodeRequest(bytes: Uint8Array): DecodedRequest {
  if (bytes.length < 8) {
    throw new CodecError({ message: "Request header is truncated" });
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, 8);
  const kind = header.getUint16(0, true);
  const flags = header.getUint16(2, true);
  const ic = header.getUint32(4, true);
  if (flags !== 0) {
    throw new CodecError({ message: `Unknown request flags: 0x${flags.toString(16).padStart(4, "0")}` });
  }
  const decode = requestDecoders.get(kind);
  if (decode === undefined) {
    throw new CodecError({ message: `Unknown request kind: ${kind}` });
  }
  // Even the empty tuple takes a byte in normal form, so a bare header is never a request.
  if (bytes.length === 8) {
    throw new CodecError({ message: "Request has no payload" });
  }
  return { ic, request: decode(bytes.subarray(8)) };
}

/** Frames `record` with a sixteen-byte header and zero padding to the record alignment. */
export function encodeRecord(seq: number, ic: number, record: OutputRecord): Uint8Array {
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) {
    throw new CodecError({ message: "Record sequence must be an unsigned 32-bit integer" });
  }
  if (!Number.isInteger(ic) || ic < 0 || ic > 0xffffffff) {
    throw new CodecError({ message: "Input context must be an unsigned 32-bit integer" });
  }
  const kind = recordKinds.get(record._tag);
  const encode = kind === undefined ? undefined : recordEncoders.get(kind);
  if (kind === undefined || encode === undefined) {
    throw new CodecError({ message: `Unknown record kind: ${record._tag}` });
  }
  if (kind === crashedKind && (seq !== 0 || ic !== 0)) {
    throw new CodecError({ message: "Crashed records must carry seq 0 and ic 0" });
  }
  const payload = encode(record);
  const bytes = new Uint8Array(Math.ceil((16 + payload.length) / RECORD_ALIGNMENT) * RECORD_ALIGNMENT);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, seq, true);
  header.setUint32(4, ic, true);
  header.setUint16(8, kind, true);
  header.setUint16(10, 0, true);
  header.setUint32(12, payload.length, true);
  bytes.set(payload, 16);
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
    throw new CodecError({ message: "Record offset is invalid or the header is truncated" });
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset + offset, 16);
  const seq = header.getUint32(0, true);
  const ic = header.getUint32(4, true);
  const kind = header.getUint16(8, true);
  const flags = header.getUint16(10, true);
  const length = header.getUint32(12, true);
  if ((flags & RECORD_CONTINUATION) !== 0) {
    throw new CodecError({ message: "Continuation records must be reassembled before decoding" });
  }
  if (flags !== 0) {
    throw new CodecError({ message: `Unknown record flags: 0x${flags.toString(16).padStart(4, "0")}` });
  }
  const decode = recordDecoders.get(kind);
  if (decode === undefined) {
    throw new CodecError({ message: `Unknown record payload kind: ${kind}` });
  }
  // seq 0 marks a host-written record, so a Crashed from anywhere else is forged or corrupt.
  if (kind === crashedKind && (seq !== 0 || ic !== 0)) {
    throw new CodecError({ message: "Crashed records must carry seq 0 and ic 0" });
  }
  const size = Math.ceil((16 + length) / RECORD_ALIGNMENT) * RECORD_ALIGNMENT;
  if (size > bytes.length - offset) {
    throw new CodecError({ message: "Record payload or padding extends beyond the buffer" });
  }
  const payloadEnd = offset + 16 + length;
  for (let index = payloadEnd; index < offset + size; index++) {
    if (bytes[index] !== 0) {
      throw new CodecError({ message: `Nonzero record padding at byte ${index}` });
    }
  }
  return { seq, ic, flags, size, kind, payload: bytes.subarray(offset + 16, payloadEnd) };
}

/**
 * Decodes the record at `offset`. Framing errors (a truncated header, an unknown kind, flags it
 * cannot handle, padding, a Crashed record the host didn't write) throw `CodecError`; a payload
 * that doesn't match its kind's schema throws `SchemaError`.
 */
export function decodeRecord(bytes: Uint8Array, offset = 0): DecodedRecord {
  const { seq, ic, flags, size, kind, payload } = readRecordEnvelope(bytes, offset);
  return { seq, ic, flags, size, record: recordDecoders.get(kind)!(payload) };
}
