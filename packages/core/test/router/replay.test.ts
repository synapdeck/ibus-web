// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import { fixture, key, output } from "./support.ts";

test("abandoned key is never resent; queued keys run ASYNC one at a time and declined keys replay in order", async () => {
  const f = fixture();
  f.connection.outcome = { _tag: "pending" };
  for (const c of ["a", "b", "c"]) expect(f.sink.key(key(c))).toBe("consumed");
  expect(f.connection.sent).toHaveLength(1);
  f.connection.completeAbandoned(0, [output(1)]);
  expect(f.connection.sent.map((r) => r.mode)).toEqual(["sync", "async"]);
  f.connection.completeAsync(0, [output(2)]);
  await Promise.resolve();
  expect(f.connection.sent.map((r) => r.request)).toMatchObject([{ keyval: 97 }, { keyval: 98 }, { keyval: 99 }]);
  f.connection.completeAsync(0);
  await Promise.resolve();
  expect(f.calls.filter((c) => c.startsWith("replay:"))).toEqual(["replay:a", "replay:b", "replay:c"]);
});

test("an unrelated async request owns busy even after its doorbell until promise records are applied", async () => {
  const f = fixture();
  f.connection.busy = true;
  expect(f.sink.key(key("a"))).toBe("consumed");
  expect(f.connection.sent).toHaveLength(0);
  f.connection.busy = false;
  f.connection.bell();
  expect(f.connection.sent).toHaveLength(1);
  expect(f.connection.sent[0]!.mode).toBe("async");
});

test("queue overflow replays all 65 events in order, clears every context and reports a hang", () => {
  const f = fixture();
  f.connection.outcome = { _tag: "pending" };
  for (let i = 0; i < 65; i++) expect(f.sink.key(key(String(i)))).toBe("consumed");
  expect(f.calls.filter((c) => c.startsWith("replay:"))).toEqual(Array.from({ length: 65 }, (_, i) => `replay:${i}`));
  expect(f.crashes).toMatchObject([{ reason: "hang" }]);
  expect(f.connection.terminated).toBe(true);
  expect(f.hidden).toEqual([1]);
  expect(f.sink.key(key("a"))).toBe("passthrough");
});

test("crash replays active async then queued keys once, ignoring its eventual rejection", async () => {
  const f = fixture();
  f.connection.busy = true;
  f.sink.key(key("a"));
  f.sink.key(key("b"));
  f.connection.busy = false;
  f.connection.bell();
  f.connection.crash();
  await Promise.resolve();
  expect(f.calls.filter((c) => c.startsWith("replay:"))).toEqual(["replay:a", "replay:b"]);
  expect(f.crashes).toHaveLength(1);
});

test("a lifecycle request holds keys until its promise has applied records, then releases exactly one", async () => {
  const f = fixture();
  const { FocusIn } = await import("@ibus-web/protocol");
  const lifecycle = f.router.request(new FocusIn({}), 1);
  f.sink.key(key("a"));
  f.sink.key(key("b"));
  f.connection.completeAsync(0, [output(1)]);
  expect(f.connection.sent).toHaveLength(1);
  await lifecycle;
  expect(f.calls.filter((c) => c.startsWith("record:"))).toEqual(["record:1"]);
  expect(f.connection.sent).toHaveLength(2);
  expect(f.connection.sent[1]!.request).toMatchObject({ keyval: 97 });
  f.connection.completeAsync(1);
  await Promise.resolve();
  expect(f.connection.sent).toHaveLength(3);
});

test("an unready context receives creation records but cannot send keys", async () => {
  const f = fixture();
  const { CreateEngine } = await import("@ibus-web/protocol");
  f.context.ready = false;
  const creation = f.router.request(new CreateEngine({ name: "test" }), 1);
  expect(f.sink.key(key("a"))).toBe("passthrough");
  f.connection.completeAsync(0, [output(1)]);
  await creation;
  expect(f.calls.filter((c) => c.startsWith("record:"))).toEqual(["record:1"]);
});
