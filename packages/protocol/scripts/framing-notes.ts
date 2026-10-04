// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { framing, type HeaderField, RECORD_CONTINUATION } from "../src/index.ts";
import { RECORD_ALIGNMENT } from "../src/messages/framing.ts";

const headerSize = (fields: readonly HeaderField[]): number => fields.reduce((size, field) => size + field.width, 0);

export const continuationFlag = `0x${RECORD_CONTINUATION.toString(16).padStart(4, "0")}`;

/** The framing rules, one paragraph each, with `code` marking identifiers and literals. */
export function framingNotes(code: (text: string) => string): string[] {
  const names = (fields: readonly HeaderField[]): string => fields.map((field) => code(field.name)).join(", ");
  return [
    "Header fields and GVariant payloads are little-endian.",
    `A request is ${headerSize(framing.request)} bytes of header (${names(framing.request)}) followed by its payload, ` +
      "the GVariant normal form of a value of its kind's signature. No payload is empty " +
      `(the empty tuple ${code("()")} is one zero byte), so a request of the header alone is malformed and ` +
      `${code("ibusweb_dispatch")} returns -EBADMSG, as it does for a payload that isn't normal form.`,
    `A record is ${headerSize(framing.record)} bytes of header (${names(framing.record)}) followed by ` +
      `${code("len")} bytes of payload in GVariant normal form, zero-padded to a multiple of ${RECORD_ALIGNMENT} bytes.`,
    `${code("Log")} and ${code("SettingWritten")} records belong to no input context: their ${code("ic")} is 0.`,
    `The runtime writes record flags as zero. ${code("CONTINUATION")} (${code(continuationFlag)}) is the only flag; ` +
      "only the host sets it, when it fragments a record.",
  ];
}
