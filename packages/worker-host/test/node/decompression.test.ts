// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { brotliCompressSync } from "node:zlib";
import { afterEach, describe, expect, test, vi } from "vitest";

type Decode = (body: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
type Wrapper = {
  decompressed(
    body: ReadableStream<Uint8Array>,
    encoding: "br" | "identity",
    forceFallback: boolean,
    decoder?: (decoder: "native" | "fallback") => void,
  ): ReadableStream<Uint8Array>;
};

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const prepared = async (fallback = true): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "ibus-web-decompression-"));
  directories.push(directory);
  await copyFile(new URL("../../src/worker/install/decompress.ts", import.meta.url), join(directory, "decompress.ts"));
  if (fallback) {
    for (const file of ["brotli-fallback.js", "brotli-fallback.js.map"])
      await copyFile(new URL(`../../dist/worker/${file}`, import.meta.url), join(directory, file));
  }
  return directory;
};

const loadWrapper = (directory: string): Promise<Wrapper> =>
  import(/* @vite-ignore */ pathToFileURL(join(directory, "decompress.ts")).href) as Promise<Wrapper>;
const loadFallback = (directory: string): Promise<{ decompress: Decode }> =>
  import(/* @vite-ignore */ pathToFileURL(join(directory, "brotli-fallback.js")).href) as Promise<{
    decompress: Decode;
  }>;

const source = () => {
  const cancelled: unknown[] = [];
  const body = new ReadableStream<Uint8Array>(
    {
      cancel(reason) {
        cancelled.push(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return { body, cancelled };
};

const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// Keep the actual WASM initialization, but control when it settles so the
// cancellation window is deterministic and independent of disk speed.
const pauseInstantiation = (failure?: Error) => {
  const entered = signal();
  const release = signal();
  const finished = signal();
  const instantiate = WebAssembly.instantiate;
  vi.spyOn(WebAssembly, "instantiate").mockImplementation(async (module, imports) => {
    entered.resolve();
    await release.promise;
    try {
      if (failure) throw failure;
      return await instantiate(module, imports);
    } finally {
      finished.resolve();
    }
  });
  return { entered, release, finished };
};

describe("Brotli stream ownership during initialization", () => {
  test("decodes with only the fallback JavaScript bundle present", async () => {
    const directory = await prepared();
    const fetching = vi.spyOn(globalThis, "fetch");
    const { decompress } = await loadFallback(directory);
    const compressed = brotliCompressSync("self-contained fallback");
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(compressed);
        controller.close();
      },
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of decompress(input)) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("self-contained fallback");
    expect(fetching).not.toHaveBeenCalled();
  });

  test("cancels the wrapper before its fallback import completes", async () => {
    const directory = await prepared();
    const { decompressed } = await loadWrapper(directory);
    const input = source();
    const reader = decompressed(input.body, "br", true).getReader();
    await expect(reader.cancel("install stopped")).resolves.toBeUndefined();
    expect(input.cancelled).toEqual(["install stopped"]);
    expect(input.body.locked).toBe(false);
    // Complete a second decode through the same module so any late import
    // and initialization of the cancelled stream have also settled.
    const compressed = brotliCompressSync("still usable");
    const next = decompressed(
      new ReadableStream({
        start(controller) {
          controller.enqueue(compressed);
          controller.close();
        },
      }),
      "br",
      true,
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of next) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("still usable");
    expect(input.cancelled).toHaveLength(1);
    expect(input.body.locked).toBe(false);
    reader.releaseLock();
  });

  test("cancels the fallback before WASM initialization completes", async () => {
    const directory = await prepared();
    const initialization = pauseInstantiation();
    try {
      const { decompress } = await loadFallback(directory);
      const input = source();
      const reader = decompress(input.body).getReader();
      await initialization.entered.promise;
      await expect(reader.cancel("install stopped")).resolves.toBeUndefined();
      expect(input.cancelled).toEqual(["install stopped"]);
      expect(input.body.locked).toBe(false);
      initialization.release.resolve();
      await initialization.finished.promise;
      await setImmediate();
      await reader.cancel("again");
      expect(input.cancelled).toHaveLength(1);
      expect(input.body.locked).toBe(false);
      reader.releaseLock();
    } finally {
      initialization.release.resolve();
      await initialization.finished.promise;
    }
  });

  test("releases the source when importing the fallback fails", async () => {
    const { decompressed } = await loadWrapper(await prepared(false));
    const input = source();
    const reader = decompressed(input.body, "br", true).getReader();
    const failure = await reader.read().then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/Brotli fallback decoder failed to load/);
    expect(failure?.message).not.toMatch(/Content-Encoding/);
    expect(input.cancelled).toHaveLength(1);
    expect(input.body.locked).toBe(false);
    reader.releaseLock();
  });

  test("releases the source when WASM initialization fails", async () => {
    const directory = await prepared();
    const failure = new Error("WASM initialization failed");
    const initialization = pauseInstantiation(failure);
    try {
      const { decompress } = await loadFallback(directory);
      const input = source();
      const reader = decompress(input.body).getReader();
      const reading = expect(reader.read()).rejects.toThrow(failure);
      await initialization.entered.promise;
      initialization.release.resolve();
      await reading;
      expect(input.cancelled).toEqual([failure]);
      expect(input.body.locked).toBe(false);
      reader.releaseLock();
    } finally {
      initialization.release.resolve();
      await initialization.finished.promise;
    }
  });

  test("keeps cancellation final if pending WASM initialization later fails", async () => {
    const directory = await prepared();
    const initialization = pauseInstantiation(new Error("late initialization failure"));
    try {
      const { decompress } = await loadFallback(directory);
      const input = source();
      const reader = decompress(input.body).getReader();
      await initialization.entered.promise;
      await expect(reader.cancel("install stopped")).resolves.toBeUndefined();
      initialization.release.resolve();
      await initialization.finished.promise;
      await setImmediate();
      expect(await reader.read()).toEqual({ done: true, value: undefined });
      expect(input.cancelled).toEqual(["install stopped"]);
      expect(input.body.locked).toBe(false);
      reader.releaseLock();
    } finally {
      initialization.release.resolve();
      await initialization.finished.promise;
    }
  });
});

// A body that sends the bytes, then fails as a network or an abort does.
const failingBody = (bytes: Uint8Array, failure: Error): ReadableStream<Uint8Array> => {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) controller.error(failure);
      else {
        sent = true;
        controller.enqueue(bytes);
      }
    },
  });
};

const bodyOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
};

const failureOf = (stream: ReadableStream<Uint8Array>): Promise<Error> =>
  readAll(stream).then(
    () => {
      throw new Error("the stream ended without failing");
    },
    (error: unknown) => error as Error,
  );

describe.each([false, true])("Brotli errors with the fallback forced %s", (forceFallback) => {
  test("say how archives must be served when the bytes don't decode", async () => {
    const { decompressed } = await loadWrapper(await prepared());
    const failure = await failureOf(decompressed(bodyOf(Uint8Array.of(255, 255, 255, 255)), "br", forceFallback));
    expect(failure.message).toMatch(/Brotli decompression failed.*Content-Encoding/);
  });

  test("keep the body's own failure, mid-stream, as a network's or an abort's", async () => {
    const { decompressed } = await loadWrapper(await prepared());
    const compressed = brotliCompressSync(Buffer.alloc(1 << 20, "x"));
    const failure = new Error("nothing arrived for 10 ms");
    const got = await failureOf(
      decompressed(failingBody(compressed.subarray(0, compressed.length >> 1), failure), "br", forceFallback),
    );
    expect(got).toBe(failure);
  });
});

describe("the decoder", () => {
  test("is reported: native where the environment decodes Brotli, the fallback when forced", async () => {
    const { decompressed } = await loadWrapper(await prepared());
    for (const forceFallback of [false, true]) {
      const used: string[] = [];
      const text = await readAll(
        decompressed(bodyOf(brotliCompressSync("decoded")), "br", forceFallback, (decoder) => used.push(decoder)),
      );
      expect(text).toBe("decoded");
      // Node decodes Brotli natively.
      expect(used).toEqual([forceFallback ? "fallback" : "native"]);
    }
  });

  test("is not reported for an identity archive", async () => {
    const { decompressed } = await loadWrapper(await prepared());
    const used: string[] = [];
    await readAll(decompressed(bodyOf(Buffer.from("plain")), "identity", false, (decoder) => used.push(decoder)));
    expect(used).toEqual([]);
  });
});
