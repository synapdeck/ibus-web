// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import initialize, { DecompressStream, BrotliStreamResultCode as Result } from "brotli-dec-wasm/web";

import wasm from "brotli-dec-wasm/web/bg.wasm";

let initialized: ReturnType<typeof initialize> | undefined;

// One output buffer per pull keeps both the decoder and fetch under the
// installer's backpressure, even when one compressed chunk expands greatly.
export const decompress = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  let decoder: DecompressStream | undefined;
  let input: Uint8Array = new Uint8Array();
  let offset = 0;
  let result = Result.NeedsMoreInput;
  let stopped = false;
  const free = () => {
    const ownedDecoder = decoder;
    decoder = undefined;
    ownedDecoder?.free();
  };
  const cancel = async (reason: unknown) => {
    if (stopped) return;
    stopped = true;
    free();
    try {
      await reader.cancel(reason);
    } finally {
      reader.releaseLock();
    }
  };
  return new ReadableStream({
    async start() {
      try {
        await (initialized ??= initialize({ module_or_path: wasm }));
        // Cancellation can finish while WASM initialization is still pending.
        if (!stopped) decoder = new DecompressStream();
      } catch (error) {
        if (stopped) return;
        await cancel(error).catch(() => {});
        throw error;
      }
    },
    async pull(controller) {
      const ownedDecoder = decoder;
      if (stopped || !ownedDecoder) return;
      try {
        for (;;) {
          if (result !== Result.NeedsMoreOutput && offset === input.length) {
            const next = await reader.read();
            if (stopped) return;
            if (next.done) {
              if (result !== Result.ResultSuccess) throw new Error("truncated Brotli stream");
              stopped = true;
              free();
              reader.releaseLock();
              controller.close();
              return;
            }
            input = next.value;
            offset = 0;
          }
          if (result === Result.ResultSuccess) throw new Error("trailing bytes after Brotli stream");
          const decoded = ownedDecoder.decompress(input.subarray(offset), 65536);
          let output: Uint8Array;
          try {
            offset += decoded.input_offset;
            result = decoded.code;
            output = decoded.buf;
          } finally {
            decoded.free();
          }
          if (output.length > 0) {
            controller.enqueue(output);
            return;
          }
        }
      } catch (error) {
        if (stopped) return;
        await cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    cancel,
  });
};
