// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

const brotliError = (cause: unknown): Error =>
  new Error(
    `Brotli decompression failed: ${String(cause)}. Serve archives as opaque bytes without Content-Encoding: br; fetch would decode them twice.`,
    { cause },
  );

export const decompressed = (
  body: ReadableStream<Uint8Array>,
  encoding: "br" | "identity",
  forceFallback = false,
): ReadableStream<Uint8Array> => {
  if (encoding === "identity") return body;
  let native: DecompressionStream | undefined;
  if (!forceFallback) {
    try {
      // Construction is the feature test; some implementations expose the
      // class but support only gzip and deflate.
      native = new DecompressionStream("brotli" as CompressionFormat);
    } catch {
      /* The separately loaded decoder supports these environments. */
    }
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  return new ReadableStream({
    async start() {
      try {
        const decoded = native
          ? body.pipeThrough(native as ReadableWritablePair<Uint8Array, Uint8Array>)
          : ((await import(/* @vite-ignore */ new URL("./brotli-fallback.js", import.meta.url).href)).decompress(
              body,
            ) as ReadableStream<Uint8Array>);
        reader = decoded.getReader();
      } catch (error) {
        throw brotliError(error);
      }
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        controller.error(brotliError(error));
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      reader.releaseLock();
    },
  });
};
