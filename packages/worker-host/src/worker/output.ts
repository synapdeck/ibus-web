// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { RingWriter } from "@ibus-web/protocol/transport";
import type { Runtime } from "./runtime.ts";

export class HostDefect extends Error {}

// The scratch word receives the runtime's output length. Consume only complete
// records that were copied, so a refused write never silently loses output.
export const drainOutput = (rt: Runtime, writer: RingWriter, words: Int32Array): number => {
  const pointer = rt._ibusweb_output_peek(words.byteOffset);
  const length = words[0]! >>> 0;
  let copied = 0;
  let count = 0;
  try {
    while (copied < length) {
      if (length - copied < 16) throw new HostDefect("truncated runtime output header");
      const header = new DataView(rt.HEAPU8.buffer, pointer + copied, 16);
      const size = Math.ceil((16 + header.getUint32(12, true)) / 8) * 8;
      if (size > length - copied) throw new HostDefect("truncated runtime output record");
      const record = rt.HEAPU8.slice(pointer + copied, pointer + copied + size);
      if (writer.write(record)._tag === "full") throw new HostDefect("output ring is full");
      copied += size;
      count++;
    }
  } finally {
    if (copied > 0) rt._ibusweb_output_consume(copied);
  }
  return count;
};
