// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ProcessKeyEvent, ProtocolError, CrashReason, transportLayout } from "@ibus-web/protocol";
import { ReqMode, State, Word, postReply } from "@ibus-web/worker-host";
import { Connection, type ConnectionOptions } from "../../src/connection/connection.ts";
import { FakeWorker, record } from "../support/fake-worker.ts";
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
test("fragment reassembly frees space and wakes a blocked writer", async () => {
  const connection = await start({ layout: transportLayout({ ringBytes: 64 }) });
  host.scripts.push({ records: [record(1, 0, "Log", "(uss)", [1, "domain", "x".repeat(250)])] });
  expect(connection.requestSync(key, 1)).toMatchObject({
    _tag: "reply",
    records: [{ record: { _tag: "Log", message: "x".repeat(250) } }],
  });
  expect(Atomics.load(host.views.words, Word.wake)).toBeGreaterThan(1);
});
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
test("a preexisting CRASHED state returns a crash before posting", async () => {
  const connection = await start();
  host.crash();
  expect(connection.requestSync(key, 1)).toMatchObject({ _tag: "crashed" });
  expect(host.requests).toHaveLength(0);
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
