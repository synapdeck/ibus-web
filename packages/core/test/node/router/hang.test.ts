// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { Connection } from "../../../src/connection/connection.ts";
import { FakeWorker, record } from "../support/fake-worker.ts";
import { fixture, key } from "../../shared/router.ts";
const module = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
let host: FakeWorker;
let dispose: (() => void) | undefined;
beforeEach(() => {
  host = new FakeWorker();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockImplementation(host.tick);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
  vi.spyOn(WebAssembly, "compileStreaming").mockResolvedValue(module);
});
afterEach(() => {
  dispose?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function start() {
  const connection = await Connection.start({
    hostUrl: new URL("https://test/host.js"),
    runtimeUrl: new URL("https://test/runtime.js"),
    manifestUrl: new URL("https://test/manifest.json"),
    storage: "none",
    worker: () => host.asWorker(),
    budgetMs: 40,
    hangMs: 2000,
  });
  const f = fixture();
  f.router.connect(connection);
  dispose = () => f.router.dispose();
  return f;
}
test("an actual budget-exhausted key remains consumed until its abandoned completion and is never redispatched", async () => {
  const f = await start();
  host.scripts.push({ after: 100, ret: 0 });
  const before = host.now;
  expect(f.sink.key(key("a"))).toBe("consumed");
  expect(host.now - before).toBeGreaterThanOrEqual(40);
  expect(host.requests).toHaveLength(1);
  while (host.now < 110) host.tick();
  host.deliver();
  expect(f.calls.filter((c) => c.startsWith("replay:"))).toEqual(["replay:a"]);
  expect(host.requests).toHaveLength(1);
});
test("no reply or ring movement for two seconds crashes and replays all held events", async () => {
  const f = await start();
  host.scripts.push({ after: "never" });
  f.sink.key(key("a"));
  f.sink.key(key("b"));
  host.now += 2000;
  vi.advanceTimersByTime(2000);
  expect(host.terminated).toBe(true);
  expect(f.crashes).toMatchObject([{ reason: "hang" }]);
  expect(f.calls.filter((c) => c.startsWith("replay:"))).toEqual(["replay:a", "replay:b"]);
});
test("ring progress resets the no-progress hang clock even without a reply", async () => {
  const f = await start();
  host.scripts.push({ after: "never" });
  f.sink.key(key("a"));
  host.now += 1990;
  host.write(record(1));
  vi.advanceTimersByTime(2000);
  expect(host.terminated).toBe(false);
  host.now += 2001;
  vi.advanceTimersByTime(2000);
  expect(host.terminated).toBe(true);
});

test("real async lifecycle reply records precede unsolicited tail records from the same doorbell", async () => {
  const f = await start();
  const { FocusIn } = await import("@ibus-web/protocol");
  const { State, Word } = await import("@ibus-web/protocol");
  host.scripts.push({ records: [record(1)] });
  const request = f.router.request(new FocusIn({}), 1);
  host.tick();
  expect(Atomics.load(host.views.words, Word.state)).toBe(State.reply);
  host.write(record(2));
  host.deliver();
  expect(f.calls).toEqual([]);
  await request;
  expect(f.calls.filter((c) => c.startsWith("record:"))).toEqual(["record:1", "record:2"]);
});

test("real async key reply owns its batch until its promise applies it, before unsolicited tail", async () => {
  const f = await start();
  const { FocusIn } = await import("@ibus-web/protocol");
  host.scripts.push({}, { records: [record(1)] });
  const request = f.router.request(new FocusIn({}), 1);
  expect(f.sink.key(key("a"))).toBe("consumed");
  host.tick();
  host.deliver();
  await request;
  host.tick();
  host.write(record(2));
  host.deliver();
  expect(f.calls).toEqual([]);
  await Promise.resolve();
  expect(f.calls.filter((c) => c.startsWith("record:"))).toEqual(["record:1", "record:2"]);
});

test("a sync reply's buffered tail is applied later without a host bell and without draining new ring output", async () => {
  const f = await start();
  const { State, Word } = await import("@ibus-web/protocol");
  host.scripts.push({ records: [record(1)] });
  let appended = false;
  host.onTick = () => {
    if (!appended && Atomics.load(host.views.words, Word.state) === State.reply) {
      appended = true;
      host.write(record(2));
    }
  };
  expect(f.sink.key(key("a"))).toBe("consumed");
  expect(f.calls.filter((c) => c.startsWith("record:"))).toEqual(["record:1"]);
  host.write(record(3));
  const ringRead = Atomics.load(host.views.words, Word.ringRead);
  await Promise.resolve();
  expect(f.calls.filter((c) => c.startsWith("record:"))).toEqual(["record:1", "record:2"]);
  expect(Atomics.load(host.views.words, Word.ringRead)).toBe(ringRead);
  host.ring();
  host.deliver();
  expect(f.calls.filter((c) => c.startsWith("record:"))).toEqual(["record:1", "record:2", "record:3"]);
});

test.each(["detach", "crash"])("the deferred sync tail is ignored after %s", async (mode) => {
  const f = await start();
  const { State, Word } = await import("@ibus-web/protocol");
  host.scripts.push({ records: [record(1)] });
  let appended = false;
  host.onTick = () => {
    if (!appended && Atomics.load(host.views.words, Word.state) === State.reply) {
      appended = true;
      host.write(record(2));
    }
  };
  f.sink.key(key("a"));
  if (mode === "detach") f.unregister();
  else {
    host.crash();
    host.deliver();
  }
  await Promise.resolve();
  expect(f.calls.filter((c) => c.startsWith("record:"))).toEqual(["record:1"]);
});

test("a buffered sync tail held by a later async lifecycle request is eventually applied in reply order", async () => {
  const f = await start();
  const { FocusIn } = await import("@ibus-web/protocol");
  const { State, Word } = await import("@ibus-web/protocol");
  host.scripts.push({ records: [record(1)] }, { records: [record(3)] });
  let appended = false;
  host.onTick = () => {
    if (!appended && Atomics.load(host.views.words, Word.state) === State.reply) {
      appended = true;
      host.write(record(2));
    }
  };
  f.sink.key(key("a"));
  const lifecycle = f.router.request(new FocusIn({}), 1);
  await Promise.resolve();
  expect(f.calls.filter((c) => c.startsWith("record:"))).toEqual(["record:1"]);
  host.tick();
  host.deliver();
  await lifecycle;
  expect(f.calls.filter((c) => c.startsWith("record:"))).toEqual(["record:1", "record:2", "record:3"]);
});

test("the buffered sync tail cannot be delivered to a new context generation", async () => {
  const f = await start();
  const { State, Word } = await import("@ibus-web/protocol");
  host.scripts.push({ records: [record(1)] });
  let appended = false;
  host.onTick = () => {
    if (!appended && Atomics.load(host.views.words, Word.state) === State.reply) {
      appended = true;
      host.write(record(2));
    }
  };
  f.sink.key(key("a"));
  f.snapshot.generation++;
  f.context.generation++;
  await Promise.resolve();
  expect(f.calls.filter((c) => c.startsWith("record:"))).toEqual(["record:1"]);
});

test("router-forced overflow retains hang reason and read-only storage for the restart lock policy", async () => {
  const f = await start();
  host.message({ type: "storage", state: "read-only", message: "another writer" });
  host.scripts.push({ after: "never" });
  for (let i = 0; i < 65; i++) f.sink.key(key("a"));
  expect(f.crashes).toEqual([{ reason: "hang", message: "Replay queue exceeded its limit", storage: "read-only" }]);
  expect(f.calls.filter((c) => c.startsWith("replay:"))).toHaveLength(65);
  expect(f.hidden).toEqual([1]);
  expect(host.terminated).toBe(true);
});

test("disposing the router does not emit a crash or schedule restart", async () => {
  const f = await start();
  f.router.dispose();
  await Promise.resolve();
  expect(host.terminated).toBe(true);
  expect(f.crashes).toEqual([]);
  expect(f.hidden).toEqual([]);
});
