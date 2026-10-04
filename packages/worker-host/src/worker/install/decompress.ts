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
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stopped = false;
  const cancel = async (reason: unknown) => {
    if (stopped) return;
    stopped = true;
    const ownedReader = reader;
    reader = undefined;
    try {
      // Before the import completes, this wrapper still owns the source.
      await (ownedReader ? ownedReader.cancel(reason) : body.cancel(reason));
    } finally {
      ownedReader?.releaseLock();
    }
  };
  return new ReadableStream({
    async start() {
      try {
        if (native) {
          reader = body.pipeThrough(native as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
        } else {
          const fallback = await import(/* @vite-ignore */ new URL("./brotli-fallback.js", import.meta.url).href);
          if (stopped) return;
          reader = (fallback.decompress(body) as ReadableStream<Uint8Array>).getReader();
        }
      } catch (error) {
        if (stopped) return;
        const failure = brotliError(error);
        await cancel(failure).catch(() => {});
        throw failure;
      }
    },
    async pull(controller) {
      const ownedReader = reader;
      if (stopped || !ownedReader) return;
      try {
        const next = await ownedReader.read();
        if (stopped) return;
        if (next.done) {
          stopped = true;
          reader = undefined;
          ownedReader.releaseLock();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        if (stopped) return;
        await cancel(error).catch(() => {});
        controller.error(brotliError(error));
      }
    },
    cancel,
  });
};
