// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import { FocusIn } from "@ibus-web/protocol";
import { ctrl, fixture, key, output } from "../../shared/router.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve));

test("a synchronous reply applies ordered records in one batch and returns its decision", () => {
  const f = fixture();
  f.connection.outcome = { _tag: "reply", ret: 1, records: [output(1), output(2)] };
  expect(f.sink.key(key("a"))).toBe("consumed");
  expect(f.calls).toEqual(["batch", "record:1", "record:2", "consumed", "end"]);
  expect(f.connection.sent[0]).toMatchObject({ ic: 1, request: { _tag: "ProcessKeyEvent", keyval: 97 } });
  f.connection.outcome = { _tag: "reply", ret: 0, records: [] };
  expect(f.sink.key(key("b"))).toBe("passthrough");
});

test("unready, disabled, stale, composing, Dead, and configured pass-through keys bypass the connection", () => {
  const f = fixture();
  f.context.ready = false;
  expect(f.sink.key(key("a"))).toBe("passthrough");
  f.context.ready = true;
  f.context.generation = -1;
  expect(f.sink.key(key("a"))).toBe("passthrough");
  f.context.generation = 0;
  f.snapshot.enabled = false;
  expect(f.sink.key(key("a"))).toBe("passthrough");
  f.snapshot.enabled = true;
  expect(f.sink.key(key("Dead"))).toBe("passthrough");
  expect(f.sink.key({ ...key("a"), isComposing: true })).toBe("passthrough");
  f.snapshot.passThrough = new Set([97]);
  expect(f.sink.key(key("a"))).toBe("passthrough");
  expect(f.connection.sent).toEqual([]);
});

test("a crash inside requestSync replays the intercepted key exactly once and returns consumed", () => {
  const f = fixture();
  f.connection.duringSync = () => f.connection.crash();
  expect(f.sink.key(key("a"))).toBe("consumed");
  expect(f.calls.filter((x) => x.startsWith("replay:"))).toEqual(["replay:a"]);
  expect(f.context.ready).toBe(false);
  expect(f.hidden).toEqual([1]);
  expect(f.crashes).toHaveLength(1);
});

test("context removal drops late records and releases its key sink", async () => {
  const f = fixture();
  f.connection.outcome = { _tag: "pending" };
  f.sink.key(key("a"));
  f.unregister();
  f.connection.completeAbandoned(0, [output(1)]);
  expect(f.calls).toEqual([]);
  expect(f.sink.key(key("a"))).toBe("passthrough");
});

test("disabled surfaces bypass translation and key releases use the same synchronous path", () => {
  const f = fixture();
  f.context.adapter.contentType = () => ({ purpose: 0, hints: 0, disabled: true });
  expect(f.sink.key(key("a"))).toBe("passthrough");
  expect(f.connection.sent).toEqual([]);
  f.context.adapter.contentType = () => ({ purpose: 0, hints: 0, disabled: false });
  expect(f.sink.key({ ...key("a"), type: "keyup" })).toBe("consumed");
  expect(f.connection.sent[0]!.request).toMatchObject({ _tag: "ProcessKeyEvent", state: 1 << 30 });
});

test("crashing one engine clears and invalidates all its registered input contexts", () => {
  const f = fixture(),
    other = fixture();
  const context = { ...other.context, ic: 2 };
  f.router.register(context);
  f.connection.outcome = { _tag: "pending" };
  f.sink.key(key("a"));
  f.router.sink(context).key(key("b"));
  f.connection.crash();
  expect(f.calls).toContain("replay:a");
  expect(other.calls).toContain("replay:b");
  expect(other.calls).toContain("clear");
  expect(other.calls).toContain("invalidate");
  expect(f.hidden).toEqual([1, 2]);
  expect(context.ready).toBe(false);
});

test("late key records do not migrate to a replacement context with the same numeric id", () => {
  const f = fixture(),
    replacement = fixture();
  f.connection.outcome = { _tag: "pending" };
  f.sink.key(key("a"));
  f.unregister();
  f.router.register(replacement.context);
  f.connection.completeAbandoned(0, [output(1)]);
  expect(replacement.calls).toEqual([]);
});

test("late lifecycle records do not migrate to a replacement context with the same numeric id", async () => {
  const f = fixture(),
    replacement = fixture();
  const { FocusIn } = await import("@ibus-web/protocol");
  const request = f.router.request(new FocusIn({}), 1);
  f.unregister();
  f.router.register(replacement.context);
  f.connection.completeAsync(0, [output(1)]);
  await request;
  expect(replacement.calls).toEqual([]);
});

test("a key arriving after a lifecycle reply is ready but before its doorbell is decided synchronously", async () => {
  const f = fixture();
  const request = f.router.request(new FocusIn({}), 1);
  f.connection.readyAsync(1, [output(1)]);
  f.connection.outcome = { _tag: "reply", ret: 0, records: [output(2)] };

  expect(f.sink.key(ctrl("z"))).toBe("passthrough");
  expect(f.connection.sent.map((sent) => sent.mode)).toEqual(["async", "sync"]);
  expect(f.calls).toEqual(["batch", "record:1", "end", "batch", "record:2", "end"]);

  await request;
  expect(f.calls.filter((call) => call.startsWith("replay:"))).toEqual([]);
});

test("a key during a lifecycle request without a reply queues and replays once when declined", async () => {
  const f = fixture();
  const request = f.router.request(new FocusIn({}), 1);

  expect(f.sink.key(ctrl("z"))).toBe("consumed");
  expect(f.connection.sent.map((sent) => sent.mode)).toEqual(["async"]);

  f.connection.completeAsync(1, []);
  await request;
  expect(f.connection.sent.map((sent) => sent.mode)).toEqual(["async", "async"]);

  f.connection.completeAsync(0, []);
  await settle();
  expect(f.calls.filter((call) => call.startsWith("replay:"))).toEqual(["replay:z"]);
});

test("held keys queue without settling a finished lifecycle reply", () => {
  const f = fixture();
  const release = f.router.holdKeys();
  void f.router.request(new FocusIn({}), 1);
  f.connection.readyAsync(1, []);

  expect(f.sink.key(ctrl("z"))).toBe("consumed");
  expect(f.connection.polls).toBe(0);
  expect(f.connection.sent.map((sent) => sent.mode)).toEqual(["async"]);
  release();
});

test("a declined retained key whose shortcut the adapter cannot perform is logged", () => {
  const f = fixture();
  f.context.adapter.replayKey = () => false;
  f.connection.outcome = { _tag: "pending" };
  f.sink.key(ctrl("v"));

  f.connection.completeAbandoned(0);
  expect(f.logs).toMatchObject([{ ic: 1, record: { _tag: "Log", level: 16, domain: "page-adapter" } }]);
});
