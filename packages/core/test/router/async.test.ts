// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test, vi } from "vitest";
import { FocusIn, SettingChanged } from "@ibus-web/protocol";
import { fixture, key, output } from "./support.ts";
const event = (value = "a") => ({ ...key(value), preventDefault: vi.fn(), stopPropagation: vi.fn() });

test("async acceptance intercepts immediately, uses only ASYNC, and applies output before settling", async () => {
  const f = fixture(),
    e = event();
  f.connection.requestSync = () => {
    throw new Error("sync path entered");
  };
  const result = f.router.keyAsync(f.context, e).then((value) => {
    f.calls.push(`settled:${value}`);
    return value;
  });
  expect(e.preventDefault).toHaveBeenCalledOnce();
  expect(e.stopPropagation).toHaveBeenCalledOnce();
  expect(f.connection.sent).toMatchObject([{ mode: "async", ic: 1, request: { keyval: 97 } }]);
  expect(f.calls).toEqual([]);
  f.connection.completeAsync(1, [output(1), output(2)]);
  expect(await result).toBe("consumed");
  expect(f.calls).toEqual(["batch", "record:1", "record:2", "consumed", "end", "settled:consumed"]);
});
test("an immediately resolved async transport never attempts synchronous dispatch", async () => {
  const f = fixture();
  f.connection.requestSync = () => {
    throw new Error("sync path entered");
  };
  f.connection.requestAsync = async () => ({ ret: 0, records: [], outSeq: 0 });
  expect(await f.router.keyAsync(f.context, event())).toBe("replayed");
  expect(f.calls).toEqual(["replay:a"]);
});
test("declined output and fallback precede dependent dispatch and settle once", async () => {
  const f = fixture();
  const send = f.connection.requestAsync.bind(f.connection);
  f.connection.requestAsync = (request, ic) => {
    f.calls.push(`send:${request._tag === "ProcessKeyEvent" ? request.keyval : request._tag}`);
    return send(request, ic);
  };
  const a = f.router.keyAsync(f.context, event("a"));
  const b = f.router.keyAsync(f.context, event("b"));
  f.connection.completeAsync(0, [output(1)]);
  expect(await a).toBe("replayed");
  expect(f.calls).toEqual(["send:97", "batch", "record:1", "end", "replay:a", "send:98"]);
  f.connection.completeAsync(1);
  expect(await b).toBe("consumed");
  expect(f.calls.filter((x) => x.startsWith("replay:"))).toEqual(["replay:a"]);
});
test("native and async owners share one FIFO and retain distinct context output", async () => {
  const f = fixture(),
    other = fixture();
  const context = { ...other.context, ic: 2 };
  f.router.register(context);
  f.connection.outcome = { _tag: "pending" };
  expect(f.sink.key(key("s"))).toBe("consumed");
  const a = f.router.keyAsync(context, event("a"));
  f.sink.key(key("t"));
  f.connection.completeAbandoned(1, [output(1)]);
  f.connection.completeAsync(0, [{ ...output(2), ic: 2 }]);
  expect(await a).toBe("replayed");
  expect(f.calls.filter((x) => x.startsWith("record:"))).toEqual(["record:1"]);
  expect(other.calls).toEqual(["batch", "record:2", "end", "replay:a"]);
  expect(f.connection.sent.map((x) => [x.mode, x.ic])).toEqual([
    ["sync", 1],
    ["async", 2],
    ["async", 1],
  ]);
  f.connection.completeAsync(0);
  await f.router.drain(f.context);
  expect(f.calls).toContain("replay:t");
});
for (const request of [
  new FocusIn({}),
  new SettingChanged({
    schemaId: "test",
    key: "mode",
    value: { _tag: "v", type: "b", value: { _tag: "b", value: true } },
  }),
])
  test(`async keys wait for ${request._tag} output before sending`, async () => {
    const f = fixture();
    const lifecycle = f.router.request(request, 1);
    const result = f.router.keyAsync(f.context, event());
    expect(f.connection.sent).toHaveLength(1);
    f.connection.completeAsync(0, [output(1)]);
    await lifecycle;
    expect(f.calls).toContain("record:1");
    expect(f.connection.sent.at(-1)!.request._tag).toBe("ProcessKeyEvent");
    f.connection.completeAsync(1);
    expect(await result).toBe("consumed");
  });
for (const close of ["detach", "dispose"])
  test(`${close} cancels active and queued awaiters and finite drains without late edits`, async () => {
    const f = fixture(),
      replacement = fixture();
    const results = [f.router.keyAsync(f.context, event("a")), f.router.keyAsync(f.context, event("b"))];
    const drain = f.router.drain(f.context);
    if (close === "detach") {
      f.unregister();
      f.router.register(replacement.context);
    } else f.router.dispose();
    expect(await Promise.all(results)).toEqual(["cancelled", "cancelled"]);
    await drain;
    if (close === "detach") f.connection.completeAsync(1, [output(1)]);
    await Promise.resolve();
    expect(f.calls).toEqual([]);
    expect(replacement.calls).toEqual([]);
  });
for (const terminal of ["crash", "reject", "overflow"])
  test(`${terminal} replays and settles all accepted async owners exactly once`, async () => {
    const f = fixture();
    const count = terminal === "overflow" ? 65 : 2;
    const results = Array.from({ length: count }, (_, i) => f.router.keyAsync(f.context, event(String(i))));
    if (terminal === "crash") f.connection.crash();
    if (terminal === "reject") f.connection.pending.shift()!.reject(new Error("failed"));
    expect(await Promise.all(results)).toEqual(Array.from({ length: count }, () => "replayed"));
    expect(f.calls.filter((x) => x.startsWith("replay:"))).toEqual(
      Array.from({ length: count }, (_, i) => `replay:${i}`),
    );
    expect(f.crashes).toHaveLength(1);
    expect(f.context.ready).toBe(false);
  });
test("retirement replays and settles the finite accepted suffix before reset, ignoring late output", async () => {
  const f = fixture();
  const a = f.router.keyAsync(f.context, event("a"));
  const b = f.router.keyAsync(f.context, event("b"));
  const drain = f.router.drain(f.context);
  f.router.retire(f.context, () => f.calls.push("finish"));
  expect(await Promise.all([a, b])).toEqual(["replayed", "replayed"]);
  await drain;
  expect(f.calls).toEqual(["batch", "finish", "replay:a", "replay:b", "end"]);
  const c = f.router.keyAsync(f.context, event("c"));
  expect(f.connection.sent).toHaveLength(1);
  f.connection.completeAsync(1, [output(1)]);
  await Promise.resolve();
  f.connection.completeAsync(0);
  expect(await c).toBe("replayed");
  expect(f.calls.filter((x) => x.startsWith("record:") || x.startsWith("replay:"))).toEqual([
    "replay:a",
    "replay:b",
    "replay:c",
  ]);
});
test("excluded async events retain native handling and never enter transport", async () => {
  const f = fixture();
  const excluded = [event("Dead"), { ...event(), isComposing: true }];
  for (const e of excluded) {
    expect(await f.router.keyAsync(f.context, e)).toBe("passthrough");
    expect(e.preventDefault).not.toHaveBeenCalled();
  }
  for (const alter of [
    () => {
      f.context.ready = false;
    },
    () => {
      f.context.generation = -1;
    },
    () => {
      f.snapshot.enabled = false;
    },
    () => {
      f.snapshot.passThrough = new Set([97]);
    },
    () => {
      f.context.adapter.contentType = () => ({ purpose: 0, hints: 0, disabled: true });
    },
  ]) {
    f.context.ready = true;
    f.context.generation = 0;
    f.snapshot.enabled = true;
    f.snapshot.passThrough = new Set();
    alter();
    const e = event();
    expect(await f.router.keyAsync(f.context, e)).toBe("passthrough");
    expect(e.preventDefault).not.toHaveBeenCalled();
  }
  expect(f.connection.sent).toEqual([]);
});
test("async keyup preserves RELEASE translation without switching the transport mode", async () => {
  const f = fixture();
  const result = f.router.keyAsync(f.context, { ...event(), type: "keyup" });
  expect(f.connection.sent[0]).toMatchObject({ mode: "async", request: { state: 1 << 30 } });
  f.connection.completeAsync(1);
  expect(await result).toBe("consumed");
});
for (const callback of ["apply", "replay"])
  test(`an async ${callback} callback failure rejects its caller and releases dependent keys and drains`, async () => {
    const f = fixture();
    const failure = new Error("adapter failed");
    if (callback === "apply")
      f.context.apply = () => {
        throw failure;
      };
    else
      f.context.adapter.replayKey = () => {
        throw failure;
      };
    const a = f.router.keyAsync(f.context, event("a"));
    const rejected = expect(a).rejects.toBe(failure);
    const drain = f.router.drain(f.context);
    const b = f.router.keyAsync(f.context, event("b"));
    f.connection.completeAsync(callback === "apply" ? 1 : 0, callback === "apply" ? [output(1)] : []);
    await rejected;
    await drain;
    expect(f.connection.sent).toHaveLength(2);
    f.connection.completeAsync(1);
    expect(await b).toBe("consumed");
  });
test("a transport throwing before returning its async promise still falls back and drains", async () => {
  const f = fixture();
  f.connection.requestAsync = () => {
    throw new Error("transport failed");
  };
  const result = f.router.keyAsync(f.context, event());
  expect(await result).toBe("replayed");
  await f.router.drain(f.context);
  expect(f.calls.filter((x) => x.startsWith("replay:"))).toEqual(["replay:a"]);
});
test("a retirement batch failure rejects all its async awaiters and releases the drain", async () => {
  const f = fixture();
  const failure = new Error("batch failed");
  const a = expect(f.router.keyAsync(f.context, event("a"))).rejects.toBe(failure);
  const b = expect(f.router.keyAsync(f.context, event("b"))).rejects.toBe(failure);
  const drain = f.router.drain(f.context);
  f.context.adapter.batch = () => {
    throw failure;
  };
  expect(() => f.router.retire(f.context)).toThrow(failure);
  await Promise.all([a, b, drain]);
  f.connection.completeAsync(1, [output(1)]);
  await Promise.resolve();
  expect(f.calls).toEqual([]);
});
test("the native synchronous sink does not construct a Promise", () => {
  const f = fixture();
  const nativePromise = globalThis.Promise;
  globalThis.Promise = new Proxy(nativePromise, {
    construct() {
      throw new Error("Promise on native stack");
    },
  });
  try {
    expect(f.sink.key(key("a"))).toBe("consumed");
    expect(f.connection.sent[0]!.mode).toBe("sync");
  } finally {
    globalThis.Promise = nativePromise;
  }
});
test("real Connection publishes ASYNC and applies ring output before settling without polling a reply", async () => {
  const { Connection } = await import("../../src/connection/connection.ts");
  const { FakeWorker, record } = await import("../support/fake-worker.ts");
  const { Word, ReqMode } = await import("@ibus-web/worker-host");
  const host = new FakeWorker(),
    f = fixture();
  const module = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
  vi.spyOn(WebAssembly, "compileStreaming").mockResolvedValue(module);
  const connection = await Connection.start({
    hostUrl: new URL("https://example.test/host.js"),
    runtimeUrl: new URL("https://example.test/async/runtime.js"),
    manifestUrl: new URL("https://example.test/engine.json"),
    storage: "none",
    budgetMs: 40,
    hangMs: 2000,
    worker: () => host.asWorker(),
  });
  try {
    f.router.connect(connection);
    vi.spyOn(connection, "requestSync").mockImplementation(() => {
      throw new Error("sync called");
    });
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    host.scripts.push({ records: [record(1)] }, { ret: 0 });
    const a = f.router.keyAsync(f.context, event("a"));
    const b = f.router.keyAsync(f.context, event("b"));
    expect(Atomics.load(host.views.words, Word.reqMode)).toBe(ReqMode.async);
    expect(clock.mock.calls.length).toBeLessThan(5);
    expect(host.requests).toHaveLength(0);
    host.tick();
    host.deliver();
    expect(await a).toBe("consumed");
    expect(f.calls).toEqual(["batch", "record:1", "consumed", "end"]);
    expect(Atomics.load(host.views.words, Word.reqMode)).toBe(ReqMode.async);
    host.tick();
    host.deliver();
    expect(await b).toBe("replayed");
    expect(f.calls.at(-1)).toBe("replay:b");
    expect(host.requests).toHaveLength(2);
  } finally {
    f.router.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
test("real Connection watchdog replays active and queued async owners and settles their drain", async () => {
  const { Connection } = await import("../../src/connection/connection.ts");
  const { FakeWorker } = await import("../support/fake-worker.ts");
  const host = new FakeWorker(),
    f = fixture();
  const module = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
  vi.spyOn(WebAssembly, "compileStreaming").mockResolvedValue(module);
  vi.useFakeTimers();
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const connection = await Connection.start({
    hostUrl: new URL("https://example.test/host.js"),
    runtimeUrl: new URL("https://example.test/async/runtime.js"),
    manifestUrl: new URL("https://example.test/engine.json"),
    storage: "none",
    budgetMs: 40,
    hangMs: 10,
    worker: () => host.asWorker(),
  });
  try {
    f.router.connect(connection);
    const a = f.router.keyAsync(f.context, event("a"));
    const b = f.router.keyAsync(f.context, event("b"));
    const drain = f.router.drain(f.context);
    clock.mockReturnValue(11);
    vi.advanceTimersByTime(10);
    expect(await Promise.all([a, b])).toEqual(["replayed", "replayed"]);
    await drain;
    expect(f.calls.filter((x) => x.startsWith("replay:"))).toEqual(["replay:a", "replay:b"]);
    expect(f.crashes).toMatchObject([{ reason: "hang" }]);
    expect(host.terminated).toBe(true);
  } finally {
    f.router.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
test("a native fallback exception during a shared crash cannot strand an async owner's settlement", async () => {
  const f = fixture();
  f.connection.outcome = { _tag: "pending" };
  f.sink.key(key("a"));
  const b = f.router.keyAsync(f.context, event("b"));
  const drain = f.router.drain(f.context);
  const failure = new Error("native fallback failed");
  f.context.adapter.replayKey = (event) => {
    if (event.key === "a") throw failure;
    f.calls.push(`replay:${event.key}`);
  };
  expect(() => f.connection.crash()).toThrow(failure);
  expect(await b).toBe("replayed");
  await drain;
  expect(f.context.ready).toBe(false);
  expect(f.crashes).toHaveLength(1);
});
for (const callback of ["output", "fallback"])
  test(`a queued native ${callback} exception reports without stalling the following async owner`, async () => {
    const f = fixture();
    f.connection.busy = true;
    f.sink.key(key("a"));
    const b = f.router.keyAsync(f.context, event("b"));
    const failure = new Error("native output failed");
    if (callback === "output")
      f.context.apply = () => {
        throw failure;
      };
    else
      f.context.adapter.replayKey = () => {
        throw failure;
      };
    try {
      f.connection.busy = false;
      f.connection.bell();
      f.connection.completeAsync(callback === "output" ? 1 : 0, callback === "output" ? [output(1)] : []);
      await Promise.resolve();
      expect(f.connection.sent).toHaveLength(2);
      f.connection.completeAsync(1);
      expect(await b).toBe("consumed");
      expect(f.errors).toEqual([failure]);
      expect(f.crashes).toEqual([]);
      expect(f.snapshot.generation).toBe(0);
    } finally {
      f.router.dispose();
      await b;
    }
  });
test("an abandoned native output exception reports and releases the following async owner", async () => {
  const f = fixture();
  f.connection.outcome = { _tag: "pending" };
  f.sink.key(key("a"));
  const b = f.router.keyAsync(f.context, event("b"));
  const failure = new Error("native output failed");
  f.context.apply = () => {
    throw failure;
  };
  expect(() => f.connection.completeAbandoned(1, [output(1)])).not.toThrow();
  expect(f.connection.sent).toHaveLength(2);
  f.connection.completeAsync(1);
  expect(await b).toBe("consumed");
  expect(f.errors).toEqual([failure]);
  expect(f.crashes).toEqual([]);
});
for (const callback of ["output", "fallback"])
  for (const request of [
    new FocusIn({}),
    new SettingChanged({
      schemaId: "test",
      key: "mode",
      value: { _tag: "v", type: "b", value: { _tag: "b", value: true } },
    }),
  ])
    test(`real Connection advances ${request._tag} and async input after abandoned native ${callback} failure`, async () => {
      const { Connection } = await import("../../src/connection/connection.ts");
      const { FakeWorker, record } = await import("../support/fake-worker.ts");
      const { Word, State, ReqMode } = await import("@ibus-web/worker-host");
      const host = new FakeWorker(),
        f = fixture();
      const module = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
      vi.spyOn(WebAssembly, "compileStreaming").mockResolvedValue(module);
      const connection = await Connection.start({
        hostUrl: new URL("https://example.test/host.js"),
        runtimeUrl: new URL("https://example.test/async/runtime.js"),
        manifestUrl: new URL("https://example.test/engine.json"),
        storage: "none",
        budgetMs: 0,
        hangMs: 2000,
        worker: () => host.asWorker(),
      });
      const promises: Promise<unknown>[] = [];
      try {
        f.router.connect(connection);
        host.scripts.push(
          { records: [record(1)], ret: callback === "output" ? 1 : 0 },
          { records: [record(2)] },
          { records: [record(3)] },
        );
        const failure = new Error(`native ${callback} failed`);
        f.context.apply = (record) => {
          if (callback === "output" && record.seq === 1) throw failure;
          f.calls.push(`record:${record.seq}`);
        };
        if (callback === "fallback")
          f.context.adapter.replayKey = () => {
            throw failure;
          };
        expect(f.sink.key(key("a"))).toBe("consumed");
        expect(Atomics.load(host.views.words, Word.reqMode)).toBe(ReqMode.abandoned);
        const lifecycle = f.router.request(request, 1);
        void lifecycle.catch(() => {});
        const b = f.router.keyAsync(f.context, event("b"));
        const drained = f.router.drain(f.context);
        promises.push(lifecycle, b, drained);
        host.tick();
        host.deliver();
        // The real transport must publish its queued lifecycle request after notifying listeners.
        expect(Atomics.load(host.views.words, Word.state)).toBe(State.request);
        expect(Atomics.load(host.views.words, Word.reqMode)).toBe(ReqMode.async);
        expect(f.errors).toEqual([]);
        host.tick();
        host.deliver();
        await lifecycle;
        expect(f.calls).toContain("record:2");
        expect(f.errors).toEqual([failure]);
        expect(Atomics.load(host.views.words, Word.state)).toBe(State.request);
        host.tick();
        host.deliver();
        expect(await b).toBe("consumed");
        await drained;
        expect(f.calls.indexOf("record:2")).toBeLessThan(f.calls.indexOf("record:3"));
        expect(host.requests).toHaveLength(3);
        expect(f.crashes).toEqual([]);
        expect(f.snapshot.generation).toBe(0);
        expect(connection.busy).toBe(false);
      } finally {
        f.router.dispose();
        await Promise.allSettled(promises);
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    });

test("reserved lifecycle work holds mixed native and async keys in the existing FIFO", async () => {
  const f = fixture();
  const release = f.router.holdKeys();
  const nested = f.router.holdKeys();
  expect(f.sink.key(key("a"))).toBe("consumed");
  const b = f.router.keyAsync(f.context, event("b"));
  expect(f.connection.sent).toEqual([]);
  release();
  release();
  expect(f.connection.sent).toEqual([]);
  nested();
  expect(f.connection.sent.map((x) => x.request)).toMatchObject([{ keyval: 97 }]);
  f.connection.completeAsync(1);
  await Promise.resolve();
  expect(f.connection.sent.map((x) => x.request)).toMatchObject([{ keyval: 97 }, { keyval: 98 }]);
  f.connection.completeAsync(1);
  expect(await b).toBe("consumed");
  expect(f.router.busy).toBe(false);
});
for (const close of ["detach", "dispose", "crash"])
  test(`reserved lifecycle keys are settled on ${close} and late release is harmless`, async () => {
    const f = fixture();
    const release = f.router.holdKeys();
    const result = f.router.keyAsync(f.context, event());
    if (close === "detach") f.unregister();
    else if (close === "dispose") f.router.dispose();
    else f.connection.crash();
    release();
    release();
    expect(await result).toBe(close === "crash" ? "replayed" : "cancelled");
    expect(f.connection.sent).toEqual([]);
    expect(f.router.busy).toBe(false);
  });

test("a reservation from a crashed generation cannot release the replacement generation", async () => {
  const f = fixture();
  const oldRelease = f.router.holdKeys();
  f.connection.crash();
  const replacement = fixture().connection;
  f.snapshot.status = "ready";
  f.context.generation = f.snapshot.generation;
  f.context.ready = true;
  f.router.connect(replacement);
  const release = f.router.holdKeys();
  const result = f.router.keyAsync(f.context, event());
  oldRelease();
  expect(replacement.sent).toEqual([]);
  release();
  expect(replacement.sent).toHaveLength(1);
  replacement.completeAsync(1);
  expect(await result).toBe("consumed");
  expect(f.router.busy).toBe(false);
});
