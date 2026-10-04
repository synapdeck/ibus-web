// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
export interface HeaderField {
  readonly name: "kind" | "flags" | "ic" | "seq" | "len";
  readonly width: 2 | 4;
  readonly description: string;
}

export const framing: { request: HeaderField[]; record: HeaderField[] } = {
  request: [
    { name: "kind", width: 2, description: "Request kind identifying the payload schema." },
    { name: "flags", width: 2, description: "Reserved request flags; must be zero." },
    { name: "ic", width: 4, description: "Input context identifier." },
  ],
  record: [
    { name: "seq", width: 4, description: "Output record sequence number." },
    { name: "ic", width: 4, description: "Input context identifier." },
    { name: "kind", width: 2, description: "Record kind identifying the payload schema." },
    { name: "flags", width: 2, description: "Record flags; only the host sets CONTINUATION when fragmenting." },
    { name: "len", width: 4, description: "Payload length in bytes, excluding the header and padding." },
  ],
};

export const RECORD_CONTINUATION = 0x0001;

/** Records are zero-padded so that each starts at a multiple of this many bytes. */
export const RECORD_ALIGNMENT = 8;

export const PADDING_KIND = 0;
