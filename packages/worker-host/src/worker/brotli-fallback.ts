// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import initialize, { DecompressStream, BrotliStreamResultCode as Result } from "brotli-dec-wasm/web";

const wasm = new URL("./brotli_dec_wasm_bg.wasm", import.meta.url);
const initialized = initialize({
  module_or_path:
    wasm.protocol === "file:"
      ? (
          import("node:fs/promises" as string) as Promise<{ readFile(url: URL): Promise<Uint8Array<ArrayBuffer>> }>
        ).then(({ readFile }) => readFile(wasm))
      : wasm,
});

// One output buffer per pull keeps both the decoder and fetch under the
// installer's backpressure, even when one compressed chunk expands greatly.
export const decompress = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  let decoder: DecompressStream;
  let input: Uint8Array = new Uint8Array();
  let offset = 0;
  let result = Result.NeedsMoreInput;
  let freed = false;
  const free = () => {
    if (!freed) {
      freed = true;
      decoder.free();
    }
  };
  return new ReadableStream({
    async start() {
      await initialized;
      decoder = new DecompressStream();
    },
    async pull(controller) {
      try {
        for (;;) {
          if (result !== Result.NeedsMoreOutput && offset === input.length) {
            const next = await reader.read();
            if (next.done) {
              if (result !== Result.ResultSuccess) throw new Error("truncated Brotli stream");
              free();
              reader.releaseLock();
              controller.close();
              return;
            }
            input = next.value;
            offset = 0;
          }
          if (result === Result.ResultSuccess) throw new Error("trailing bytes after Brotli stream");
          const decoded = decoder.decompress(input.subarray(offset), 65536);
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
        free();
        await reader.cancel(error).catch(() => {});
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      free();
      await reader.cancel(reason);
      reader.releaseLock();
    },
  });
};
