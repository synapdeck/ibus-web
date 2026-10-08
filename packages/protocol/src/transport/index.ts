// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
export {
  DEFAULT_RING_BYTES,
  DEFAULT_SLOT_BYTES,
  HEADER_BYTES,
  MAX_RING_BYTES,
  MIN_FRAGMENT_PAYLOAD_BYTES,
  MIN_RING_BYTES,
  RECORD_HEADER_BYTES,
  ReqMode,
  State,
  transportLayout,
  transportViews,
  Word,
  wordDescriptions,
  type TransportLayout,
  type TransportViews,
} from "./layout.ts";
export { RingReader, RingWriter, type WriteResult } from "./ring.ts";
