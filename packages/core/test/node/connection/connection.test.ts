// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  IBusLookupTable,
  UpdateLookupTable,
  encodeValue,
  signatureOf,
  Init,
  PROTOCOL_VERSION,
  ProcessKeyEvent,
  ProtocolError,
  CrashReason,
  ReqMode,
  State,
  transportLayout,
  Word,
  type PanelEvent,
} from "@ibus-web/protocol";
import { Schema } from "effect";
import { toTree } from "../../../../protocol/src/ibus/walk.ts";
import { InputContext } from "../../../src/router/contexts.ts";
import { fixture as routerFixture } from "../../shared/router.ts";
import { postReply } from "@ibus-web/worker-host";
import { Connection, PrepareFailed, type ConnectionOptions } from "../../../src/connection/connection.ts";
import { FakeWorker, record } from "../support/fake-worker.ts";
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const key = new ProcessKeyEvent({ keyval: 97, keycode: 30, state: 0 });
let host: FakeWorker;
let connections: Connection[];
const module = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
beforeEach(() => {
  host = new FakeWorker();
  connections = [];
  vi.spyOn(performance, "now").mockImplementation(host.tick);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
  vi.spyOn(WebAssembly, "compileStreaming").mockResolvedValue(module);
});
afterEach(() => {
  connections.forEach((c) => c.terminate());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function start(extra: Partial<ConnectionOptions> = {}) {
  const connection = await Connection.start({
    hostUrl: new URL("https://example.test/host.js"),
    runtimeUrl: new URL("https://example.test/runtime/ibus-runtime.js"),
    manifestUrl: new URL("https://example.test/engine/manifest.json"),
    storage: "none",
    budgetMs: 40,
    hangMs: 2000,
    worker: () => host.asWorker(),
    ...extra,
  });
  connections.push(connection);
  return connection;
}

function lookupRecord(corrupt = false) {
  const text = (text: string) => ({ attachments: {}, text, attrs: { attachments: {}, attributes: [] } });
  const value = new UpdateLookupTable({
    visible: true,
    table: IBusLookupTable.make({
      attachments: {},
      pageSize: 2,
      cursorPos: 0,
      cursorVisible: true,
      round: false,
      orientation: 0,
      candidates: [text("first"), text("second"), text("invisible")],
      labels: [text("1"), text("2")],
    }),
  });
  const payload = encodeValue(
    signatureOf(UpdateLookupTable),
    toTree(UpdateLookupTable)(Schema.encodeSync(UpdateLookupTable)(value)),
  );
  const bytes = new Uint8Array(Math.ceil((16 + payload.length) / 8) * 8);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 1, true);
  header.setUint32(4, 7, true);
  header.setUint16(8, 4, true);
  header.setUint32(12, payload.length, true);
  bytes.set(payload, 16);
  if (corrupt) bytes[Buffer.from(bytes).indexOf("invisible")] = 0xff;
  return bytes;
}

describe("startup and shutdown", () => {
  test("bootstraps one host with URL-only init and cached runtime compilation", async () => {
    const runtimeUrl = new URL("https://example.test/cache/runtime.js");
    await start({ runtimeUrl });
    await start({ runtimeUrl });
    expect(WebAssembly.compileStreaming).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(new URL("https://example.test/cache/ibus-runtime.wasm"));
    expect(host.init).toMatchObject({
      runtimeUrl: runtimeUrl.href,
      wasm: module,
      storage: { kind: "none" },
      manifestUrl: "https://example.test/engine/manifest.json",
    });
    expect(host.init).not.toHaveProperty("constants");
  });

  test("startup host error rejects and stops the worker", async () => {
    vi.spyOn(host, "postMessage").mockImplementation(() => host.message({ type: "error", message: "bad manifest" }));
    await expect(start()).rejects.toThrow("bad manifest");
    expect(host.terminated).toBe(true);
  });

  test("default factory starts a module Worker at hostUrl", async () => {
    const created = vi.fn();
    vi.stubGlobal(
      "Worker",
      class {
        constructor(url: URL, options: WorkerOptions) {
          created(url, options);
          return host;
        }
      },
    );
    const connection = await Connection.start({
      hostUrl: new URL("https://example.test/native-host.js"),
      runtimeUrl: new URL("https://example.test/runtime/ibus-runtime.js"),
      manifestUrl: new URL("https://example.test/engine/manifest.json"),
      storage: "browser",
      budgetMs: 40,
      hangMs: 2000,
    });
    connections.push(connection);
    expect(created).toHaveBeenCalledWith(new URL("https://example.test/native-host.js"), { type: "module" });
    expect(host.init.storage).toEqual({ kind: "browser" });
  });

  test("failed compilation is evicted so the next start retries", async () => {
    const runtimeUrl = new URL("https://example.test/retry/ibus-runtime.js");
    vi.mocked(WebAssembly.compileStreaming).mockRejectedValueOnce(new Error("compile failed"));
    await expect(start({ runtimeUrl })).rejects.toThrow("compile failed");
    await start({ runtimeUrl });
    expect(WebAssembly.compileStreaming).toHaveBeenCalledTimes(2);
  });

  test("aborting startup terminates a Worker that has not announced ready and removes its listeners", async () => {
    const controller = new AbortController();
    const posted = deferred<void>();
    vi.spyOn(host, "postMessage").mockImplementation(() => {
      posted.resolve();
    });
    const removed = vi.spyOn(host, "removeEventListener");
    const terminated = vi.spyOn(host, "terminate");
    const pending = start({ signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await posted.promise;
    controller.abort();
    expect(host.terminated).toBe(true);
    expect(removed.mock.calls.map(([type]) => type)).toEqual(["message", "error", "messageerror"]);
    await rejected;
    host.message({ type: "ready", startupMs: 0 });
    expect(terminated).toHaveBeenCalledTimes(1);
  });

  test("aborting during shared compilation rejects promptly and cannot create a Worker later", async () => {
    const controller = new AbortController();
    const compilation = deferred<WebAssembly.Module>();
    const compiled = deferred<void>();
    vi.mocked(WebAssembly.compileStreaming).mockImplementationOnce(() => {
      compiled.resolve();
      return compilation.promise;
    });
    const worker = vi.fn(() => host.asWorker());
    const runtimeUrl = new URL("https://example.test/canceled-compile/runtime.js");
    const pending = start({ runtimeUrl, signal: controller.signal, worker });
    const otherWorker = vi.fn(() => host.asWorker());
    const other = start({ runtimeUrl, worker: otherWorker });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await compiled.promise;
    controller.abort();
    try {
      await rejected;
      expect(worker).not.toHaveBeenCalled();
      expect(otherWorker).not.toHaveBeenCalled();
    } finally {
      compilation.resolve(module);
    }
    await other;
    expect(worker).not.toHaveBeenCalled();
    expect(otherWorker).toHaveBeenCalledTimes(1);
    expect(WebAssembly.compileStreaming).toHaveBeenCalledTimes(1);
  });

  test("an already-aborted startup cannot compile or create a Worker", async () => {
    const controller = new AbortController();
    controller.abort();
    const worker = vi.fn(() => host.asWorker());
    await expect(
      start({
        runtimeUrl: new URL("https://example.test/already-aborted/runtime.js"),
        signal: controller.signal,
        worker,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
  });

  test("aborting after ready but before startup hands off terminates the Worker", async () => {
    const controller = new AbortController();
    const post = host.postMessage.bind(host);
    vi.spyOn(host, "postMessage").mockImplementation((init) => {
      post(init);
      controller.abort();
    });
    await expect(start({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(host.terminated).toBe(true);
  });

  test("startup signal no longer owns an established connection", async () => {
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const connection = await start({ signal: controller.signal });
    controller.abort();
    expect(host.terminated).toBe(false);
    expect(removed.mock.calls.filter(([type]) => type === "abort")).toHaveLength(2);
    host.scripts.push({ records: [] });
    expect(connection.requestSync(key, 1)).toMatchObject({ _tag: "reply" });
  });

  test("unsubscribe removes listeners and terminate rejects outstanding work", async () => {
    const connection = await start();
    const crash = vi.fn(),
      bell = vi.fn();
    connection.onCrash(crash)();
    connection.onDoorbell(bell)();
    host.ring();
    host.deliver();
    const reply = connection.requestAsync(key, 1);
    const rejected = expect(reply).rejects.toMatchObject({ reason: "worker" });
    connection.terminate();
    await rejected;
    expect(crash).not.toHaveBeenCalled();
    expect(bell).not.toHaveBeenCalled();
  });

  test("forced termination retains caller reason and last storage state exactly once", async () => {
    const connection = await start();
    const listener = vi.fn();
    connection.onCrash(listener);
    host.message({ type: "storage", state: "read-only", message: "lock held" });
    connection.terminate({ reason: "hang", message: "overflow" });
    connection.terminate();
    expect(listener).toHaveBeenCalledExactlyOnceWith({ reason: "hang", message: "overflow", storage: "read-only" });
  });

  test("storage callbacks expose Worker messages without waiting for a crash", async () => {
    const states: unknown[] = [];
    await start({ onStorage: (message) => states.push(message) });
    host.message({ type: "storage", state: "read-only", message: "writer elsewhere" });
    expect(states).toEqual([{ state: "read-only", message: "writer elsewhere" }]);
  });

  test("a failed collection of other versions' data is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await start();
    host.message({ type: "collect", removed: ["1"], inUse: [] });
    expect(warn).not.toHaveBeenCalled();
    host.message({ type: "collect", removed: [], inUse: [], error: "QuotaExceededError" });
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("QuotaExceededError"));
  });
});

describe("synchronous replies", () => {
  test("sync reply includes records through outSeq; later output stays for take", async () => {
    const connection = await start();
    host.scripts.push({ records: [record(1)] });
    const outcome = connection.requestSync(key, 4);
    expect(outcome).toMatchObject({ _tag: "reply", ret: 1, records: [{ seq: 1 }] });
    expect(new DataView(host.requests[0]!.buffer).getUint32(4, true)).toBe(4);
    host.write(record(2));
    expect(connection.records.take().map((r) => r.seq)).toEqual([2]);
    expect(Atomics.load(host.views.words, Word.state)).toBe(State.idle);
  });

  test("waits for records even when REPLY is visible first", async () => {
    const connection = await start();
    host.scripts.push({ records: [record(1)], recordsAfterReply: 5 });
    expect(connection.requestSync(key, 1)).toMatchObject({ _tag: "reply", records: [{ seq: 1 }] });
    expect(host.now).toBeGreaterThanOrEqual(6);
  });

  test("budget exhaustion abandons and does not overwrite busy slot", async () => {
    const connection = await start();
    host.scripts.push({ after: "never" });
    expect(connection.requestSync(key, 1)).toEqual({ _tag: "pending" });
    expect(Atomics.load(host.views.words, Word.reqMode)).toBe(ReqMode.abandoned);
    expect(connection.busy).toBe(true);
    expect(() => connection.requestSync(key, 2)).toThrow("in-flight");
    expect(host.requests).toHaveLength(1);
  });

  test("reply in the abandonment compare-exchange race completes synchronously", async () => {
    const connection = await start();
    host.scripts.push({ after: "never" });
    const original = Atomics.compareExchange;
    vi.spyOn(Atomics, "compareExchange").mockImplementation(((
      words: Int32Array,
      index: number,
      expected: number,
      replacement: number,
    ) => {
      if (words.buffer === host.views.words.buffer && index === Word.reqMode && replacement === ReqMode.abandoned)
        postReply(host.views, 0, 0);
      return original(words, index, expected, replacement);
    }) as typeof Atomics.compareExchange);
    expect(connection.requestSync(key, 1)).toEqual({ _tag: "reply", ret: 0, records: [] });
  });

  test("output already past replyOutSeq stays outside the synchronous batch", async () => {
    const connection = await start();
    host.scripts.push({ records: [record(1)] });
    let appended = false;
    host.onTick = () => {
      if (!appended && Atomics.load(host.views.words, Word.state) === State.reply) {
        appended = true;
        host.write(record(2));
      }
    };
    expect(connection.requestSync(key, 1)).toMatchObject({ _tag: "reply", records: [{ seq: 1 }] });
    expect(appended).toBe(true);
    expect(connection.records.take().map((r) => r.seq)).toEqual([2]);
  });

  test("all sync drains stop at the deadline despite replenished output, then complete once without a host bell", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const connection = await start({ budgetMs: 3 });
    let elapsed = 0;
    vi.mocked(performance.now).mockImplementation(() => {
      host.tick();
      return elapsed;
    });
    let seq = 1;
    host.write(record(seq));
    const original = Atomics.store;
    vi.spyOn(Atomics, "store").mockImplementation(((words: Int32Array, index: number, value: number) => {
      const result = original(words, index, value);
      if (words.buffer === host.views.words.buffer && index === Word.ringRead) {
        elapsed++;
        if (seq < 10) host.write(record(++seq));
      }
      return result;
    }) as typeof Atomics.store);
    const bell = vi.fn();
    connection.onDoorbell(bell);
    expect(connection.requestSync(key, 1)).toEqual({ _tag: "pending" });
    expect(elapsed).toBeLessThanOrEqual(3);
    expect(Atomics.load(host.views.words, Word.reqMode)).toBe(ReqMode.abandoned);
    expect(Atomics.load(host.views.words, Word.doorbell)).toBe(0);
    vi.advanceTimersByTime(0);
    expect(connection.replies.take()).toMatchObject([
      { ret: 1, outSeq: 4, records: [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }] },
    ]);
    expect(connection.records.take().map((r) => r.seq)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(connection.replies.take()).toEqual([]);
    expect(host.requests).toHaveLength(1);
    expect(connection.busy).toBe(false);
    expect(bell).toHaveBeenCalledTimes(1);
  });

  test("sync fragment draining yields within budget and resumes the same abandoned batch in order", async () => {
    const connection = await start({ budgetMs: 3, layout: transportLayout({ ringBytes: 64 }) });
    let elapsed = 0;
    vi.mocked(performance.now).mockImplementation(() => {
      host.tick();
      return elapsed;
    });
    host.scripts.push({ records: [record(1, 0, "Log", "(uss)", [1, "test", "z".repeat(500)]), record(2)] });
    const original = Atomics.store;
    vi.spyOn(Atomics, "store").mockImplementation(((words: Int32Array, index: number, value: number) => {
      const result = original(words, index, value);
      if (words.buffer === host.views.words.buffer && index === Word.ringRead) {
        elapsed++;
        host.tick();
      }
      return result;
    }) as typeof Atomics.store);
    expect(connection.requestSync(key, 1)).toEqual({ _tag: "pending" });
    expect(elapsed).toBeLessThanOrEqual(3);
    expect(connection.busy).toBe(true);
    host.deliver();
    for (let i = 0; i < 15 && connection.busy; i++) {
      host.tick();
      host.deliver();
    }
    expect(connection.replies.take()).toMatchObject([
      { records: [{ seq: 1, record: { message: "z".repeat(500) } }, { seq: 2 }] },
    ]);
    expect(connection.records.take()).toEqual([]);
    expect(host.requests).toHaveLength(1);
    expect(connection.busy).toBe(false);
  });

  test("a reply with unread output arriving during abandonment defers its drain without losing completion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const connection = await start({ budgetMs: 3 });
    host.scripts.push({ after: "never" });
    const original = Atomics.compareExchange;
    vi.spyOn(Atomics, "compareExchange").mockImplementation(((
      words: Int32Array,
      index: number,
      expected: number,
      replacement: number,
    ) => {
      if (words.buffer === host.views.words.buffer && index === Word.reqMode && replacement === ReqMode.abandoned) {
        host.write(record(1));
        postReply(host.views, 0, 1);
      }
      return original(words, index, expected, replacement);
    }) as typeof Atomics.compareExchange);
    expect(connection.requestSync(key, 1)).toEqual({ _tag: "pending" });
    expect(Atomics.load(host.views.words, Word.ringRead)).toBe(0);
    expect(Atomics.load(host.views.words, Word.doorbell)).toBe(0);
    vi.advanceTimersByTime(0);
    expect(connection.replies.take()).toMatchObject([{ ret: 0, outSeq: 1, records: [{ seq: 1 }] }]);
    expect(host.requests).toHaveLength(1);
    expect(connection.busy).toBe(false);
  });

  test("reply acquisition keeps non-crash invariant errors visible", async () => {
    const connection = await start();
    const original = Atomics.compareExchange;
    vi.spyOn(Atomics, "compareExchange").mockImplementation(((
      words: Int32Array,
      index: number,
      expected: number,
      replacement: number,
    ) => {
      if (
        words.buffer === host.views.words.buffer &&
        index === Word.state &&
        expected === State.reply &&
        replacement === State.idle
      )
        return State.idle;
      return original(words, index, expected, replacement);
    }) as typeof Atomics.compareExchange);
    expect(() => connection.requestSync(key, 1)).toThrow("reply state changed before it was taken");
    expect(host.terminated).toBe(false);
  });
});

describe("asynchronous replies", () => {
  test("async replies resolve on doorbell and requests are serialized", async () => {
    const connection = await start();
    const first = connection.requestAsync(key, 1);
    const second = connection.requestAsync(key, 2);
    host.tick();
    host.deliver();
    expect(await first).toEqual({ ret: 1, outSeq: 0, records: [] });
    host.tick();
    host.deliver();
    expect(await second).toEqual({ ret: 1, outSeq: 0, records: [] });
    expect(host.requests.map((r) => new DataView(r.buffer).getUint32(4, true))).toEqual([1, 2]);
  });

  test("clears doorbell before draining; coalesced output is not stranded", async () => {
    const connection = await start();
    host.write(record(1));
    host.ring();
    host.write(record(2));
    host.ring();
    const original = Atomics.store;
    const seen: number[] = [];
    vi.spyOn(Atomics, "store").mockImplementation((words, index, value) => {
      if (words.buffer === host.views.words.buffer && index === Word.ringRead)
        seen.push(Atomics.load(host.views.words, Word.doorbell));
      return original(words, index, value);
    });
    host.deliver();
    expect(seen).toEqual([0, 0]);
    expect(connection.records.take().map((r) => r.seq)).toEqual([1, 2]);
  });

  test("abandoned and queued async replies each own their records exactly once", async () => {
    const connection = await start({ budgetMs: 3 });
    host.scripts.push({ after: 8, ret: 0, records: [record(1)] }, { records: [record(2)] });
    expect(connection.requestSync(key, 1)).toEqual({ _tag: "pending" });
    expect(connection.records.take()).toEqual([]);
    const next = connection.requestAsync(key, 2);
    for (let i = 0; i < 10; i++) host.tick();
    host.deliver();
    expect(connection.replies.take()).toMatchObject([{ ret: 0, outSeq: 1, records: [{ seq: 1 }] }]);
    expect(connection.replies.take()).toEqual([]);
    host.tick();
    host.deliver();
    expect(await next).toMatchObject({ ret: 1, outSeq: 2, records: [{ seq: 2 }] });
    expect(connection.records.take()).toEqual([]);
  });

  test("async reply does not resolve until its advertised output has drained", async () => {
    const connection = await start();
    host.scripts.push({ records: [record(1)], recordsAfterReply: 5 });
    let resolved = false;
    const pending = connection.requestAsync(key, 1).then((reply) => {
      resolved = true;
      return reply;
    });
    host.deliver();
    await Promise.resolve();
    expect(resolved).toBe(false);
    for (let i = 0; i < 6; i++) host.tick();
    host.deliver();
    expect(await pending).toMatchObject({ records: [{ seq: 1 }] });
  });

  test("a real doorbell supersedes deferred completion and queued requests retain their own batch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const connection = await start({ budgetMs: 0 });
    host.scripts.push({ records: [record(1)] }, { records: [record(2)] });
    expect(connection.requestSync(key, 1)).toEqual({ _tag: "pending" });
    const queued = connection.requestAsync(key, 2);
    const bell = vi.fn();
    connection.onDoorbell(bell);
    host.ring();
    host.deliver();
    expect(connection.replies.take()).toMatchObject([{ outSeq: 1, records: [{ seq: 1 }] }]);
    host.deliver();
    expect(await queued).toMatchObject({ outSeq: 2, records: [{ seq: 2 }] });
    const notifications = bell.mock.calls.length;
    vi.advanceTimersByTime(0);
    expect(bell).toHaveBeenCalledTimes(notifications);
    expect(connection.replies.take()).toEqual([]);
    expect(connection.records.take()).toEqual([]);
    expect(host.requests).toHaveLength(2);
  });
});

describe("output records", () => {
  test("fragment reassembly frees space and wakes a blocked writer", async () => {
    const connection = await start({ layout: transportLayout({ ringBytes: 64 }) });
    host.scripts.push({ records: [record(1, 0, "Log", "(uss)", [1, "domain", "x".repeat(250)])] });
    expect(connection.requestSync(key, 1)).toMatchObject({
      _tag: "reply",
      records: [{ record: { _tag: "Log", message: "x".repeat(250) } }],
    });
    expect(Atomics.load(host.views.words, Word.wake)).toBeGreaterThan(1);
  });

  test.each([record(2), record(0, 5)])("invalid sequence or host ic is logged and dropped", async (bytes) => {
    const connection = await start();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    host.write(bytes);
    expect(connection.records.take()).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.any(ProtocolError));
  });

  test("development throws ProtocolError", async () => {
    const connection = await start({ development: true });
    host.write(record(2));
    expect(() => connection.records.take()).toThrow(ProtocolError);
  });

  test("doorbell during fragment backpressure does not release an incomplete reply's records", async () => {
    const connection = await start({ layout: transportLayout({ ringBytes: 64 }) });
    host.scripts.push({ records: [record(1), record(2, 0, "Log", "(uss)", [1, "test", "y".repeat(200)])] });
    const reply = connection.requestAsync(key, 1);
    host.tick();
    host.deliver();
    expect(connection.busy).toBe(true);
    expect(connection.records.take()).toEqual([]);
    for (let i = 0; i < 12; i++) {
      host.tick();
      host.deliver();
    }
    expect(await reply).toMatchObject({ records: [{ seq: 1 }, { seq: 2 }] });
  });

  test("sequence validation resumes after a dropped gap and skips zero on wrap", async () => {
    const connection = await start();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    host.write(record(0xffffffff));
    expect(connection.records.take()).toEqual([]);
    host.write(record(1));
    expect(connection.records.take().map((r) => r.seq)).toEqual([1]);
    host.write(record(3));
    host.write(record(4));
    expect(connection.records.take().map((r) => r.seq)).toEqual([4]);
    expect(log).toHaveBeenCalledTimes(2);
  });

  test("host records do not advance the runtime sequence", async () => {
    const connection = await start();
    host.scripts.push({ records: [record(1), record(0, 0, "Log", "(uss)", [1, "host", "notice"]), record(2)] });
    expect(connection.requestSync(key, 1)).toMatchObject({
      _tag: "reply",
      records: [{ seq: 1 }, { seq: 0 }, { seq: 2 }],
    });
  });

  test("ring movement keeps an incomplete request alive until progress stops", async () => {
    vi.useFakeTimers();
    const connection = await start({ hangMs: 10 });
    host.scripts.push({ after: "never" });
    const pending = connection.requestAsync(key, 1);
    const rejected = expect(pending).rejects.toMatchObject({ reason: "hang" });
    host.now += 8;
    host.write(record(1));
    vi.advanceTimersByTime(10);
    expect(host.terminated).toBe(false);
    host.now += 11;
    vi.advanceTimersByTime(10);
    await rejected;
  });

  test("malformed payload is logged and dropped without blocking a valid successor", async () => {
    const connection = await start();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const invalid = record(1);
    new DataView(invalid.buffer).setUint16(8, 0xffff, true);
    host.write(invalid);
    host.write(record(2));
    expect(connection.records.take().map((r) => r.seq)).toEqual([2]);
    expect(log).toHaveBeenCalledWith(expect.any(ProtocolError));
  });

  test("buffered output access does not drain a live ring or steal in-flight reply records", async () => {
    const connection = await start();
    host.write(record(1));
    expect(connection.records.takeBuffered()).toEqual([]);
    expect(Atomics.load(host.views.words, Word.ringRead)).toBe(0);
    host.scripts.push({ after: 100, records: [record(2)] });
    expect(connection.requestSync(key, 1)).toEqual({ _tag: "pending" });
    expect(connection.records.takeBuffered()).toEqual([]);
    while (host.now < 150) host.tick();
    host.deliver();
    expect(connection.replies.take()).toMatchObject([{ records: [{ seq: 1 }, { seq: 2 }] }]);
    host.scripts.push({ records: [record(3)] });
    let appended = false;
    host.onTick = () => {
      if (!appended && Atomics.load(host.views.words, Word.state) === State.reply) {
        appended = true;
        host.write(record(4));
      }
    };
    expect(connection.requestSync(key, 1)).toMatchObject({ _tag: "reply", records: [{ seq: 3 }] });
    host.write(record(5));
    const read = Atomics.load(host.views.words, Word.ringRead);
    expect(connection.records.takeBuffered()).toMatchObject([{ seq: 4 }]);
    expect(connection.records.takeBuffered()).toEqual([]);
    expect(Atomics.load(host.views.words, Word.ringRead)).toBe(read);
    expect(connection.records.take()).toMatchObject([{ seq: 5 }]);
  });

  test("buffered output access observes CRASHED before returning stale records", async () => {
    const connection = await start();
    host.write(record(1));
    host.ring();
    host.deliver();
    host.crash();
    expect(connection.records.takeBuffered()).toEqual([]);
    expect(host.terminated).toBe(true);
  });

  test.each([false, true])(
    "production reply delivers lazy lookup to the panel and retains bytes after ring reuse (corrupt=%s)",
    async (corrupt) => {
      const connection = await start({ layout: transportLayout({ ringBytes: 1024 }), development: true });
      host.scripts.push({ records: [lookupRecord(corrupt)] });
      const outcome = connection.requestSync(key, 7);
      expect(outcome._tag).toBe("reply");
      if (outcome._tag !== "reply") throw new Error("missing reply");
      const decoded = outcome.records[0]!;
      const events: PanelEvent[] = [];
      const {
        context: { adapter },
      } = routerFixture();
      const context = new InputContext({
        ic: 7,
        module: "test",
        engine: "test",
        generation: 1,
        adapter,
        current: () => true,
        refresh: () => {},
        panel: (event) => events.push(event),
      });
      context.apply(decoded);
      expect(events).toHaveLength(1);
      const event = events[0]!;
      if (event._tag !== "record" || event.record._tag !== "UpdateLookupTable") throw new Error("missing table");
      const lazy = event.record.table;
      expect(lazy.visible().candidates.map((item) => item.text)).toEqual(["first", "second"]);
      for (let seq = 2; seq < 100; seq++) {
        expect(host.write(record(seq))).toBe(true);
        connection.records.take();
      }
      expect(Atomics.load(host.views.words, Word.ringWrite)).toBeGreaterThan(1024);
      if (corrupt) expect(() => lazy.page(1)).toThrow();
      else expect(lazy.page(1).candidates.map((item) => item.text)).toEqual(["invisible"]);
    },
  );
});

describe("preparing an engine", () => {
  test("posts PrepareEngine outside the request slot, counts it in the mail word and hears its progress", async () => {
    const connection = await start();
    const progress: [number, number][] = [];
    const prepared = connection.prepare("lazy", (bytes, total) => progress.push([bytes, total]));
    await Promise.resolve();
    expect(host.prepares).toEqual([{ engine: "lazy", mail: 1 }]);
    expect(Atomics.load(host.views.words, Word.state)).toBe(State.idle);
    expect(connection.busy).toBe(false);
    host.message({ type: "prepare-progress", engine: "lazy", bytes: 0, total: 10 });
    host.message({ type: "prepare-progress", engine: "other", bytes: 5, total: 5 });
    host.message({ type: "prepare-progress", engine: "lazy", bytes: 10, total: 10 });
    host.message({ type: "prepared", engine: "lazy" });
    await expect(prepared).resolves.toBeUndefined();
    expect(progress).toEqual([
      [0, 10],
      [10, 10],
    ]);
  });
  test("answers each engine's prepares in the order they were posted", async () => {
    const connection = await start();
    const first = connection.prepare("lazy");
    const second = connection.prepare("lazy");
    const other = connection.prepare("other");
    host.message({ type: "prepared", engine: "other" });
    host.message({ type: "prepared", engine: "lazy", error: "no space" });
    host.message({ type: "prepared", engine: "lazy" });
    await expect(other).resolves.toBeUndefined();
    await expect(first).rejects.toEqual(new PrepareFailed("no space"));
    await expect(second).resolves.toBeUndefined();
  });
  test("a crash rejects the prepares it cut short, and later ones at once", async () => {
    const connection = await start();
    const pending = connection.prepare("lazy");
    host.message({ type: "crashed", message: "trap" });
    await expect(pending).rejects.toMatchObject({ reason: "host", message: "trap" });
    await expect(connection.prepare("lazy")).rejects.toMatchObject({ reason: "host" });
  });
});

describe("crashes and hangs", () => {
  test.each(Object.entries(CrashReason))("Crashed preserves %s reason", async (reason, code) => {
    const connection = await start();
    const listener = vi.fn();
    connection.onCrash(listener);
    host.write(record(0, 0, "Crashed", "(us)", [code, "stopped"]));
    host.crash();
    host.deliver();
    expect(listener).toHaveBeenCalledWith({ reason, message: "stopped" });
    expect(connection.requestSync(key, 1)).toMatchObject({ _tag: "crashed", crash: { reason } });
  });

  test.each(["state", "message", "worker"])("crash from %s rejects pending work once", async (source) => {
    const connection = await start();
    const listener = vi.fn();
    connection.onCrash(listener);
    const reply = connection.requestAsync(key, 1);
    const rejected = expect(reply).rejects.toMatchObject({ reason: source === "worker" ? "worker" : "host" });
    if (source === "state") {
      host.crash();
      host.deliver();
    } else if (source === "message") host.message({ type: "crashed", message: "stopped" });
    else host.dispatchEvent(new Event("error"));
    await rejected;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(host.terminated).toBe(true);
  });

  test("a hang rejects queued requests and terminates the host", async () => {
    vi.useFakeTimers();
    const connection = await start({ hangMs: 10 });
    host.scripts.push({ after: "never" });
    const reply = connection.requestAsync(key, 1);
    const rejected = expect(reply).rejects.toMatchObject({ reason: "hang" });
    host.now += 11;
    vi.advanceTimersByTime(10);
    await rejected;
    expect(host.terminated).toBe(true);
  });

  test("a preexisting CRASHED state returns a crash before posting", async () => {
    const connection = await start();
    host.crash();
    expect(connection.requestSync(key, 1)).toMatchObject({ _tag: "crashed" });
    expect(host.requests).toHaveLength(0);
  });

  test("crash carries the last storage state and rejects every queued request", async () => {
    const connection = await start();
    host.message({ type: "storage", state: "read-only", message: "lock held" });
    host.scripts.push({ after: "never" });
    const first = connection.requestAsync(key, 1);
    const second = connection.requestAsync(key, 2);
    const failures = Promise.all([
      expect(first).rejects.toMatchObject({ storage: "read-only" }),
      expect(second).rejects.toMatchObject({ storage: "read-only" }),
    ]);
    host.crash();
    host.deliver();
    await failures;
    expect(connection.busy).toBe(false);
  });

  test("a crash racing request publication returns a crash instead of stranding busy state", async () => {
    const connection = await start();
    const original = Atomics.compareExchange;
    vi.spyOn(Atomics, "compareExchange").mockImplementation(((
      words: Int32Array,
      index: number,
      expected: number,
      replacement: number,
    ) => {
      if (words.buffer === host.views.words.buffer && index === Word.state && replacement === State.request)
        Atomics.store(words, Word.state, State.crashed);
      return original(words, index, expected, replacement);
    }) as typeof Atomics.compareExchange);
    expect(connection.requestSync(key, 1)).toMatchObject({ _tag: "crashed", crash: { reason: "host" } });
    expect(connection.busy).toBe(false);
  });

  test.each(["sync", "async"] as const)("CRASHED racing %s reply acquisition follows normal cleanup", async (mode) => {
    const registration = vi.spyOn(host, "addEventListener");
    const connection = await start();
    const crash = vi.fn();
    connection.onCrash(crash);
    const original = Atomics.compareExchange;
    vi.spyOn(Atomics, "compareExchange").mockImplementation(((
      words: Int32Array,
      index: number,
      expected: number,
      replacement: number,
    ) => {
      if (
        words.buffer === host.views.words.buffer &&
        index === Word.state &&
        expected === State.reply &&
        replacement === State.idle
      )
        Atomics.store(words, Word.state, State.crashed);
      return original(words, index, expected, replacement);
    }) as typeof Atomics.compareExchange);
    if (mode === "sync")
      expect(connection.requestSync(key, 1)).toMatchObject({ _tag: "crashed", crash: { reason: "host" } });
    else {
      const pending = connection.requestAsync(key, 1);
      const rejected = expect(pending).rejects.toMatchObject({ reason: "host" });
      // Capture listener exceptions in this call instead of Node's later uncaught-event turn.
      const dispatch = vi.spyOn(host, "dispatchEvent").mockImplementation((event) => {
        const listener = registration.mock.calls.find(([type]) => type === "message")?.[1];
        if (typeof listener === "function") listener.call(host, event);
        return true;
      });
      host.deliver();
      dispatch.mockRestore();
      await rejected;
    }
    expect(crash).toHaveBeenCalledTimes(1);
    expect(connection.busy).toBe(false);
    expect(host.terminated).toBe(true);
  });
});

describe("Init watchdog", () => {
  test("Init may finish after the interactive watchdog budget, then a queued key uses its own budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const connection = await start();
    host.scripts.push({ after: 8000, ret: 0 }, { after: "never" });
    const initial = connection.requestAsync(new Init({ version: PROTOCOL_VERSION, settings: [] }), 0);
    const first = initial.catch((cause: unknown) => cause);
    const queued = connection.requestAsync(key, 1);
    const rejected = expect(queued).rejects.toMatchObject({ reason: "hang" });
    host.now += 7999;
    vi.advanceTimersByTime(7999);
    expect(host.terminated).toBe(false);
    host.tick();
    host.deliver();
    expect(await first).toMatchObject({ ret: 0, records: [] });
    host.now += 2000;
    vi.advanceTimersByTime(2000);
    await rejected;
    expect(host.terminated).toBe(true);
  });

  test.each([undefined, 5000])("Init without progress eventually hangs with budget %s", async (initHangMs) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const connection = await start(initHangMs === undefined ? {} : { initHangMs });
    host.scripts.push({ after: "never" });
    const pending = connection.requestAsync(new Init({ version: PROTOCOL_VERSION, settings: [] }), 0);
    const rejected = expect(pending).rejects.toMatchObject({ reason: "hang" });
    const budget = initHangMs ?? 30000;
    host.now += budget - 1;
    vi.advanceTimersByTime(budget - 1);
    expect(host.terminated).toBe(false);
    host.now += 1;
    vi.advanceTimersByTime(1);
    await rejected;
    expect(host.terminated).toBe(true);
  });

  test("Init ring movement refreshes only its bounded progress watchdog", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const connection = await start({ initHangMs: 5000 });
    host.scripts.push({ after: "never" });
    const pending = connection.requestAsync(new Init({ version: PROTOCOL_VERSION, settings: [] }), 0);
    const rejected = expect(pending).rejects.toMatchObject({ reason: "hang" });
    host.now += 4000;
    host.write(record(1));
    vi.advanceTimersByTime(5000);
    expect(host.terminated).toBe(false);
    host.now += 5001;
    vi.advanceTimersByTime(5000);
    await rejected;
  });

  test.each([0, -1, Infinity, NaN])(
    "invalid Init watchdog budget %s fails before creating a Worker",
    async (initHangMs) => {
      const worker = vi.fn(() => host.asWorker());
      await expect(start({ initHangMs, worker })).rejects.toThrow(RangeError);
      expect(worker).not.toHaveBeenCalled();
    },
  );
});
