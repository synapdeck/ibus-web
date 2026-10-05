// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

export type BrotliDecoder = "native" | "fallback";

const brotliError = (cause: unknown): Error =>
  new Error(
    `Brotli decompression failed: ${String(cause)}. Serve archives as opaque bytes without Content-Encoding: br; fetch would decode them twice.`,
    { cause },
  );

const loadError = (cause: unknown): Error =>
  new Error(`Brotli fallback decoder failed to load: ${String(cause)}`, { cause });

// The body as the decoder reads it, remembering how the body itself failed:
// a decoder passes such a failure on, maybe as its own, and only one that
// starts in the decoder says anything about the archive's bytes. The body
// stays unlocked until the decoder first reads, so that a cancel before then
// reaches it directly.
const watched = (body: ReadableStream<Uint8Array>) => {
  const state: { failure?: { error: unknown }; reader?: ReadableStreamDefaultReader<Uint8Array> } = {};
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        state.reader ??= body.getReader();
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await state.reader.read();
        } catch (error) {
          state.failure = { error };
          throw error;
        }
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel(reason) {
        const { reader } = state;
        if (reader === undefined) return body.cancel(reason);
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, failure: () => state.failure };
};

// The archive's bytes, decoded as encoding says. decoder hears which
// decoder a Brotli archive goes through.
export const decompressed = (
  body: ReadableStream<Uint8Array>,
  encoding: "br" | "identity",
  forceFallback = false,
  decoder?: (decoder: BrotliDecoder) => void,
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
  const source = watched(body);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stopped = false;
  const cancel = async (reason: unknown) => {
    if (stopped) return;
    stopped = true;
    const ownedReader = reader;
    reader = undefined;
    try {
      // Before the import completes, this wrapper still owns the source.
      await (ownedReader ? ownedReader.cancel(reason) : source.stream.cancel(reason));
    } finally {
      ownedReader?.releaseLock();
    }
  };
  return new ReadableStream({
    async start() {
      try {
        if (native) {
          reader = source.stream.pipeThrough(native as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
          decoder?.("native");
        } else {
          const fallback = await import(/* @vite-ignore */ new URL("./brotli-fallback.js", import.meta.url).href);
          if (stopped) return;
          reader = (fallback.decompress(source.stream) as ReadableStream<Uint8Array>).getReader();
          decoder?.("fallback");
        }
      } catch (error) {
        if (stopped) return;
        const failure = loadError(error);
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
        const failure = source.failure();
        controller.error(failure === undefined ? brotliError(error) : failure.error);
      }
    },
    cancel,
  });
};
