// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The host's scenarios, each against a host it is given and asserting its
// criterion. Each records what it measured; no time is asserted on except
// where the criterion is a time. They talk to the host only through the
// control buffer, so either test environment runs them.

import { expect } from "vitest";
import type { Reply } from "../../src/shared/control.ts";
import type { Client } from "./client.ts";
import type { Harness, RunningHost, RuntimeBuild } from "./harness.ts";
import { HostOp, type HostStats } from "./testing.ts";

// The test side modules' operations, under their C names in camel case
// (SPIKE_OP_SPAWN_DETACHED is spawnDetached).
const opNames = [
  "add",
  "idleLater",
  "idleResult",
  "spawn",
  "spawnResult",
  "throw",
  "spawnDetached",
  "spawnDetachedResult",
  "spawnNested",
  "spawnNestedResult",
  "proxySync",
  "proxySyncResult",
  "task",
  "taskResult",
  "timeout",
  "timeoutResult",
  "crashThread",
  "hold",
  "release",
  "memStress",
  "memStressResult",
  "glibStress",
  "glibStressResult",
  "memInfo",
  "memGrow",
  "fsync",
  "fsyncResult",
  "writeFile",
  "readFile",
  "readFileRdwr",
  "benchWrite",
  "benchRead",
  "benchAppend",
  "listTree",
] as const;

export type Ops = Readonly<Record<(typeof opNames)[number], number>>;

export const opsFrom = (ops: Readonly<Record<string, number>>): Ops => {
  const byName = new Map(
    Object.entries(ops).map(([name, opcode]) => [
      name.toLowerCase().replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      opcode,
    ]),
  );
  const missing = opNames.filter((name) => !byName.has(name));
  if (missing.length > 0) throw new Error(`the build defines no opcode for ${missing.join(", ")}`);
  return Object.fromEntries(opNames.map((name) => [name, byName.get(name)!])) as Ops;
};

const decoder = new TextDecoder();

export const int32s = (...values: number[]): Uint8Array => new Uint8Array(new Int32Array(values).buffer);

export const replyInt32s = ({ ret, bytes }: Reply): number[] => {
  if (ret < 0) return [ret];
  if (bytes.length % 4 !== 0) throw new Error(`a reply of ${bytes.length} bytes, not int32s`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  return Array.from({ length: bytes.length / 4 }, (_, i) => view.getInt32(i * 4, true));
};

export const call32 = async (client: Client, opcode: number, payload?: Uint8Array): Promise<number> => {
  const values = replyInt32s(await client.call(opcode, payload));
  if (values.length !== 1) throw new Error(`a reply of ${values.length} int32s, not one`);
  return values[0]!;
};

const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? Number.NaN;

export const round = (value: number, digits = 3): number => Number(value.toFixed(digits));

export const errno = (h: Harness, name: string): number => {
  const value = h.data.errno[name];
  if (value === undefined) throw new Error(`no ${name} in Emscripten's errno.h`);
  return value;
};

export const opsOf = (h: Harness): Ops => opsFrom(h.data.constants.ops);

// Asks for a result every intervalMs until it is no longer -EAGAIN; fails
// once the harness's pending limit has passed. value is the reply's first
// int32.
export const poll = async (
  h: Harness,
  client: Client,
  opcode: number,
  intervalMs = 2,
): Promise<{ value: number; values: number[]; ms: number }> => {
  const start = h.now();
  for (;;) {
    const values = replyInt32s(await client.call(opcode));
    const value = values[0]!;
    const ms = h.now() - start;
    if (value !== -errno(h, "EAGAIN")) return { value, values, ms };
    expect(ms, `opcode ${opcode}'s result still pending`).toBeLessThanOrEqual(h.pendingLimitMs);
    await h.sleep(intervalMs);
  }
};

export const stats = async (client: Client): Promise<HostStats> => {
  const { ret, bytes } = await client.call(HostOp.stats);
  if (ret < 0) throw new Error(`host stats: ${ret}`);
  return JSON.parse(decoder.decode(bytes)) as HostStats;
};

const hostYield = async (client: Client): Promise<void> => {
  expect((await client.call(HostOp.yield)).ret, "host yield").toBe(0);
};

const setTopUps = async (client: Client, allowed: boolean): Promise<void> => {
  expect((await client.call(HostOp.topUp, int32s(allowed ? 1 : 0))).ret, "host top-up").toBe(0);
};

// Creates n threads that keep their Workers until release().
const hold = async (h: Harness, client: Client, n: number): Promise<void> => {
  expect(replyInt32s(await client.call(opsOf(h).hold, int32s(n))), `hold(${n}): held, error`).toEqual([n, 0]);
};

const release = async (h: Harness, client: Client): Promise<void> => {
  expect(await call32(client, opsOf(h).release), "release").toBeGreaterThanOrEqual(0);
};

// Stats once the host has finished a top-up after since, or the latest
// stats if none finishes within the pending limit. A request would wait out
// a top-up's new Worker() calls in Firefox, where they return only while the
// page's thread is free, so the first waits a moment.
const awaitTopUp = async (h: Harness, client: Client, since: HostStats): Promise<HostStats> => {
  const deadline = h.now() + h.pendingLimitMs;
  await h.sleep(50);
  let latest = await stats(client);
  while (latest.topUps === since.topUps && h.now() < deadline) {
    await h.sleep(5);
    latest = await stats(client);
  }
  return latest;
};

// Round trips of add, each with its sum checked, in microseconds.
const addRoundTrips = async (
  h: Harness,
  client: Client,
  rounds: number,
  gapMs: number,
): Promise<{ times: number[]; wrong: number }> => {
  const times: number[] = [];
  let wrong = 0;
  for (let i = 0; i < rounds; i++) {
    if (gapMs > 0) await h.sleep(gapMs);
    const start = h.now();
    const sum = await call32(client, opsOf(h).add, int32s(i, 1000));
    times.push((h.now() - start) * 1000);
    if (sum !== i + 1000) wrong++;
  }
  times.sort((a, b) => a - b);
  return { times, wrong };
};

const latencies = (sorted: readonly number[]): Record<string, number> => ({
  p50Us: round(percentile(sorted, 50), 1),
  p99Us: round(percentile(sorted, 99), 1),
  maxUs: round(sorted.at(-1) ?? Number.NaN, 1),
});

// Every call so far held its thread no longer than its budget: a reply that
// needed the page to let go fails whichever test waited for it.
export const noLateReplies = (client: Client): void => {
  expect(client.lateReplies, "replies that came only after the page let its thread go").toEqual([]);
};

// 1000 add round trips back to back, every sum right. The next request
// often lands before the host has gone back to sleep, so these times mix
// requests served at once with ones that woke the host. A browser's clock
// steps in tens of microseconds, about a round trip, so each batch of
// requests is also timed whole, for a mean finer than the step.
export const dispatch = async (h: Harness, { client, instrumented }: RunningHost): Promise<void> => {
  const before = instrumented ? await stats(client) : undefined;
  const times: number[] = [];
  const means: number[] = [];
  let wrong = 0;
  for (let b = 0; b < 10; b++) {
    const start = h.now();
    const batch = await addRoundTrips(h, client, 100, 0);
    means.push(((h.now() - start) * 1000) / 100);
    times.push(...batch.times);
    wrong += batch.wrong;
  }
  const after = before === undefined ? undefined : await stats(client);
  times.sort((a, b) => a - b);
  means.sort((a, b) => a - b);
  h.record("dispatch", {
    ...latencies(times),
    batchMeanUs: round(percentile(means, 50), 2),
    batchMeanRangeUs: [round(means[0]!, 2), round(means.at(-1)!, 2)],
    ...(before === undefined || after === undefined
      ? {}
      : {
          requestsWhileAsleep: `${after.requestsWhileAsleep - before.requestsWhileAsleep} of ${after.requests - before.requests}`,
        }),
  });
  expect(wrong, "wrong sums").toBe(0);
};

// 300 add round trips, each sent 2 ms after the last reply: every sum right,
// and at least 95% found the host asleep, so the round trip paid the whole
// wake path, relay and host. A host descheduled on a loaded machine can
// still be awake when a request lands, which only shortens that round trip,
// so a few such requests are allowed.
export const coldWake = async (h: Harness, { client }: RunningHost): Promise<void> => {
  const gapMs = 2;
  const before = await stats(client);
  const { times, wrong } = await addRoundTrips(h, client, 300, gapMs);
  await h.sleep(gapMs);
  const after = await stats(client);
  const requests = after.requests - before.requests;
  const asleep = after.requestsWhileAsleep - before.requestsWhileAsleep;
  h.record("cold-wake", {
    ...latencies(times),
    meanUs: round(times.reduce((sum, t) => sum + t, 0) / times.length, 2),
    requestsWhileAsleep: `${asleep} of ${requests}`,
  });
  expect(wrong, "wrong sums").toBe(0);
  expect(asleep, `requests of ${requests} that found the host asleep`).toBeGreaterThanOrEqual(requests * 0.95);
};

// idle-later(50) ×20 with the host idle: attach to dispatch p50 ≤ 20 ms, and
// every time within 200 ms. The host gets no request while the source is
// pending, so only GLib's wake can get it dispatched; the first poll wakes
// the host too, so it waits until a source left for that would be later
// than the bound. The bound is generous: a host on a loaded machine is
// descheduled now and then.
export const crossThreadWake = async (h: Harness, { client }: RunningHost, boundMs = 200): Promise<void> => {
  const ops = opsOf(h);
  const epsilons: number[] = [];
  for (let i = 0; i < 20; i++) {
    expect(await call32(client, ops.idleLater, int32s(50)), "idle-later").toBe(0);
    await h.sleep(50 + boundMs + 150);
    epsilons.push((await poll(h, client, ops.idleResult)).value / 1000);
  }
  const sorted = [...epsilons].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  h.record("cross-thread-wake", {
    p50Ms: round(p50),
    maxMs: round(sorted.at(-1)!),
    minMs: round(sorted[0]!),
    boundMs,
  });
  expect(sorted[0], "the earliest dispatch, after its attach").toBeGreaterThanOrEqual(0);
  expect(p50, "median attach to dispatch, ms").toBeLessThanOrEqual(20);
  expect(sorted.at(-1), "longest attach to dispatch, ms").toBeLessThanOrEqual(boundMs);
};

// g_timeout_add(100) ×5 with no requests: dispatched at 100 ± 10 ms every
// time.
export const deadline = async (h: Harness, { client }: RunningHost): Promise<void> => {
  const ops = opsOf(h);
  const delays: number[] = [];
  for (let i = 0; i < 5; i++) {
    expect(await call32(client, ops.timeout, int32s(100)), "timeout").toBe(0);
    await h.sleep(300);
    delays.push(round((await poll(h, client, ops.timeoutResult)).value / 1000));
  }
  const worst = Math.max(...delays.map((ms) => Math.abs(ms - 100)));
  h.record("deadline", { delaysMs: delays, worstDeviationMs: round(worst) });
  expect(worst, "worst deviation from 100 ms").toBeLessThanOrEqual(10);
};

// A burst of the side modules' share of threads alive at once, spawn(share)
// from a pump and spawn-nested(share - 1) from a thread, whose creations the
// host runs while it sleeps, starts and joins every thread, creating no
// Worker and never returning the host to its event loop: every thread
// starts on a Worker that has already loaded. Runs before any other scenario
// starts a thread, so the pool holds only the Workers it started with.
export const threadCreateBlocked = async (h: Harness, { client }: RunningHost): Promise<void> => {
  const ops = opsOf(h);
  const n = h.data.pool.engine;
  const before = await stats(client);
  expect(before.idleWorkers, `idle Workers of a pool of ${h.data.pool.size}`).toBeGreaterThanOrEqual(n);
  const measurements: Record<string, string> = {};
  const burst = async (label: string, start: number, result: number, threads: number) => {
    const first = await stats(client);
    const startedAt = h.now();
    expect(await call32(client, start, int32s(threads)), label).toBe(0);
    const [count, error] = (await poll(h, client, result)).values;
    const ms = h.now() - startedAt;
    const last = await stats(client);
    const created = last.workersCreated - first.workersCreated;
    const turns = last.eventLoopTurns - first.eventLoopTurns;
    measurements[label] =
      `joined ${count} in ${round(ms, 1)} ms, error ${error}, ${created} Workers created, ${turns} event-loop turns`;
    return { count, error, created, turns };
  };
  const spawned = await burst("spawn", ops.spawn, ops.spawnResult, n);
  // The thread doing the creating is one of the burst.
  const nested = await burst("nested", ops.spawnNested, ops.spawnNestedResult, n - 1);
  h.record("thread-create-blocked", measurements);
  expect(spawned, "spawn").toEqual({ count: n, error: 0, created: 0, turns: 0 });
  expect(nested, "spawn-nested").toEqual({ count: n - 1, error: 0, created: 0, turns: 0 });
};

// The pool's Workers: those it started with, plus those created since, by
// top-ups or, under Node, by Emscripten itself.
const poolWorkers = (h: Harness, { workersCreated }: HostStats): number => h.data.pool.size + workersCreated;

const threadsAlive = (h: Harness, at: HostStats): number => poolWorkers(h, at) - at.idleWorkers;

const describeStats = (h: Harness, at: HostStats, since: HostStats): string =>
  `${threadsAlive(h, at)} threads alive, ${at.idleWorkers} of ${poolWorkers(h, at)} Workers idle; ` +
  `${at.workersCreated - since.workersCreated} Workers created, ${at.topUps - since.topUps} top-ups, ` +
  `${at.eventLoopTurns - since.eventLoopTurns} event-loop turns`;

// With as many threads alive as the shares plan for and the host idle, the
// host leaves the pool as it is, with its spare Workers idle; with one more
// alive, it tops the pool up by one Worker, back to its low-water mark of
// idle Workers, by itself. The host decides as soon as it has answered a
// request, and a top-up it starts creates its Workers and counts an
// event-loop turn at once.
export const poolTopUp = async (h: Harness, { client }: RunningHost): Promise<void> => {
  const { planned, lowWater } = h.data.pool;
  const first = await stats(client);
  const toPeak = planned - threadsAlive(h, first);
  expect(toPeak, `threads alive already, of ${planned} planned`).toBeGreaterThanOrEqual(1);
  await hold(h, client, toPeak);
  // Time for a top-up's new Worker() calls to return, in Firefox too, where
  // they wait for the page's thread.
  await h.sleep(50);
  const peak = await stats(client);
  await release(h, client);

  const before = await stats(client);
  await hold(h, client, toPeak + 1);
  const over = await awaitTopUp(h, client, before);
  await release(h, client);
  h.record("pool-top-up", {
    plannedPeak: describeStats(h, peak, first),
    overshoot:
      describeStats(h, over, before) +
      (over.topUps === before.topUps ? "" : `; the top-up took ${round(over.lastTopUpMs!, 1)} ms`),
  });
  expect(
    {
      alive: threadsAlive(h, peak),
      idle: peak.idleWorkers,
      created: peak.workersCreated - first.workersCreated,
      topUps: peak.topUps - first.topUps,
      turns: peak.eventLoopTurns - first.eventLoopTurns,
    },
    "at the planned peak",
  ).toEqual({ alive: planned, idle: lowWater, created: 0, topUps: 0, turns: 0 });
  expect(
    {
      alive: threadsAlive(h, over),
      idle: over.idleWorkers,
      created: over.workersCreated - before.workersCreated,
      topUps: over.topUps - before.topUps,
      added: over.topUpWorkers - before.topUpWorkers,
    },
    "one past the planned peak",
  ).toEqual({ alive: planned + 1, idle: lowWater, created: 1, topUps: 1, added: 1 });
};

// With every idle Worker taken and top-ups held off, a thread created from a
// pump and one created from another thread (proxied to the host) fail with
// EAGAIN at once, and the host keeps answering; with top-ups allowed again,
// the host restores the pool's low-water mark of idle Workers by itself, and
// a burst of that many starts on them. Under Node, Emscripten creates a
// Worker beyond the pool instead, so this runs in browsers only. The idle
// count it reads first must hold throughout: sync-proxied's GTask worker, if
// that ran, stays alive some 15.5 s after its task.
export const poolExhausted = async (h: Harness, { client }: RunningHost): Promise<void> => {
  const ops = opsOf(h);
  const eagain = -errno(h, "EAGAIN");
  const attempt = async (start: number, result: number, n: number) => {
    const startedAt = h.now();
    expect(await call32(client, start, int32s(n)), "start").toBe(0);
    const [joined, error] = (await poll(h, client, result)).values;
    return { joined, error, ms: round(h.now() - startedAt, 2) };
  };

  await setTopUps(client, false);
  const first = await stats(client);
  const idle = first.idleWorkers;
  await hold(h, client, idle);
  const fromPump = await attempt(ops.spawn, ops.spawnResult, 1);
  await release(h, client);
  // The creating thread takes the last idle Worker itself.
  await hold(h, client, idle - 1);
  const proxied = await attempt(ops.spawnNested, ops.spawnNestedResult, 1);
  await release(h, client);
  const answering = await call32(client, ops.add, int32s(2, 3));

  await hold(h, client, idle);
  const emptied = await stats(client);
  await setTopUps(client, true);
  const topped = await awaitTopUp(h, client, emptied);
  const lowWater = topped.topUpWorkers - emptied.topUpWorkers;
  const burst = await attempt(ops.spawn, ops.spawnResult, lowWater);
  const last = await stats(client);
  await release(h, client);
  h.record("pool-exhausted", {
    idleWorkers: idle,
    fromPump: `joined ${fromPump.joined}, error ${fromPump.error}, in ${fromPump.ms} ms`,
    proxied: `joined ${proxied.joined}, error ${proxied.error}, in ${proxied.ms} ms`,
    topUp:
      topped.topUps === emptied.topUps
        ? "none"
        : `${lowWater} Workers in ${round(topped.lastTopUpMs!, 1)} ms ` +
          `(new Worker() ${round(topped.lastTopUpCreateMs!, 2)} ms); ${topped.idleWorkers} idle`,
    burstAfterTopUp: `joined ${burst.joined}, error ${burst.error}, in ${burst.ms} ms`,
  });
  expect({ joined: fromPump.joined, error: fromPump.error }, "a thread from a pump").toEqual({
    joined: 0,
    error: eagain,
  });
  expect({ joined: proxied.joined, error: proxied.error }, "a thread from a thread").toEqual({
    joined: 0,
    error: eagain,
  });
  expect(answering, "add after").toBe(5);
  expect(topped.topUps - emptied.topUps, "top-ups once allowed").toBe(1);
  expect(lowWater, "Workers the top-up added").toBe(h.data.pool.lowWater);
  expect(topped.idleWorkers, "idle Workers after the top-up").toBe(lowWater);
  expect({ joined: burst.joined, error: burst.error }, "a burst on the new Workers").toEqual({
    joined: lowWater,
    error: 0,
  });
  expect(last.workersCreated - first.workersCreated, "Workers created in all").toBe(lowWater);
};

// What the runtime prints of the failed creations: the side module's warning
// for each, and, asserting, Emscripten's for an empty pool.
export const poolExhaustedPrinted = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  await h.printed.take(
    /WARNING \*\*: .*spawn: thread 1 of 1: Error creating thread: Resource temporarily unavailable$/,
    {
      count: 2,
    },
  );
  if (runtime.name === "asserting")
    for (const line of [
      /Tried to spawn a new thread, but the thread pool is exhausted/,
      /^This might result in a deadlock unless some threads eventually exit/,
      /^If you want to increase the pool size, use setting `-sPTHREAD_POOL_SIZE=...`\.$/,
    ])
      await h.printed.take(line, { count: 2 });
};

const MiB = 2 ** 20;

// 5 rounds of spawn-detached(the side modules' share) with the host never
// returning to its event loop: heap in use after each round within 0.5 MiB
// of the first round's, no Worker created in a round that began with enough
// idle Workers, and nothing left for the event loop to reclaim. A detached
// thread ends without a join on the host's thread, as GLib's pool workers
// do.
export const threadExitBlocked = async (h: Harness, { client }: RunningHost): Promise<void> => {
  const ops = opsOf(h);
  const n = h.data.pool.engine;
  const idle: number[] = [];
  const created: number[] = [];
  const heap: number[] = [];
  for (let i = 0; i < 5; i++) {
    const before = await stats(client);
    expect(await call32(client, ops.spawnDetached, int32s(n)), "spawn-detached").toBe(n);
    await poll(h, client, ops.spawnDetachedResult);
    // Lets the threads finish exiting.
    await h.sleep(50);
    const after = await stats(client);
    idle.push(before.idleWorkers);
    created.push(after.workersCreated - before.workersCreated);
    heap.push(after.heapInUse);
  }
  await hostYield(client);
  const afterYield = (await stats(client)).heapInUse;
  h.record("thread-exit-blocked", {
    idleWorkersBefore: idle,
    workersCreated: created,
    heapInUseMiB: heap.map((bytes) => round(bytes / MiB, 2)),
    afterYieldHeapInUseMiB: round(afterYield / MiB, 2),
  });
  for (const [round, bytes] of heap.entries())
    expect(Math.abs(bytes - heap[0]!), `round ${round + 1}'s heap in use, from the first's`).toBeLessThanOrEqual(
      MiB / 2,
    );
  for (const [round, count] of created.entries())
    if (idle[round]! >= n) expect(count, `Workers created in round ${round + 1}`).toBe(0);
  expect(heap.at(-1)! - afterYield, "heap the event loop reclaimed").toBeLessThanOrEqual(MiB / 2);
};

// While the host sleeps: a call proxied synchronously to its thread, a thread
// creating threads, and a GTask a thread starts in GLib's thread pool all
// complete, and the GTask keeps GLib's share of Workers busy: its first use
// starts GLib's worker-context thread and the thread pool's spawner, kept
// for good, and a worker, kept a while.
export const syncProxied = async (h: Harness, { client }: RunningHost): Promise<void> => {
  const ops = opsOf(h);
  const measurements: Record<string, number> = {};
  // Each result is microseconds to completion, or the count joined.
  const complete = async (label: string, start: number, payload: Uint8Array | undefined, result: number) => {
    expect(await call32(client, start, payload), label).toBe(0);
    const { value } = await poll(h, client, result);
    measurements[label] = value;
    return value;
  };
  const proxy = await complete("proxySyncUs", ops.proxySync, undefined, ops.proxySyncResult);
  const nested = await complete("spawnNestedJoined", ops.spawnNested, int32s(2), ops.spawnNestedResult);
  const before = await stats(client);
  const task = await complete("taskUs", ops.task, undefined, ops.taskResult);
  // Lets the thread that started the task end.
  await h.sleep(50);
  const after = await stats(client);
  const kept = before.idleWorkers - after.idleWorkers;
  h.record("sync-proxied", { ...measurements, workersKeptAfterTask: kept, glibThreads: h.data.pool.glib });
  expect(proxy, "proxy-sync").toBeGreaterThanOrEqual(0);
  expect(nested, "spawn-nested(2) joined").toBe(2);
  expect(task, "task").toBeGreaterThanOrEqual(0);
  expect(kept, "Workers the GTask keeps").toBe(h.data.pool.glib);
};

// throw replies -ECANCELED, then add still works; the runtime's warning of
// the throw is the only output.
export const exceptions = async (h: Harness, { client }: RunningHost): Promise<void> => {
  const ops = opsOf(h);
  const thrown = await call32(client, ops.throw);
  const after = await call32(client, ops.add, int32s(1, 1));
  h.record("exceptions", { throwReply: thrown, addAfter: after });
  expect(thrown, "throw").toBe(-errno(h, "ECANCELED"));
  expect(after, "add after").toBe(2);
  await h.printed.take(new RegExp(`ibus-web-WARNING.*Operation ${ops.throw} threw`), { count: 1 });
};

// Requests to a host once it has crashed fail, as the page sees them.
const callsUntilCrashed = async (h: Harness, client: Client): Promise<boolean> => {
  const ops = opsOf(h);
  const deadline = h.now() + h.pendingLimitMs;
  while (h.now() < deadline) {
    try {
      await client.call(ops.add, int32s(1, 1));
      await h.sleep(10);
    } catch {
      return true;
    }
  }
  return false;
};

// A thread that traps takes the host down: requests fail as crashed, and the
// host reports that thread's error, not only Emscripten's unwinding of the
// host. Takes the host down, so it runs on a host of its own.
export const threadCrash = async (h: Harness, { client }: RunningHost): Promise<string> => {
  expect(await call32(client, opsOf(h).crashThread), "crash-thread").toBe(0);
  const crashed = await callsUntilCrashed(h, client);
  const report = await client.crashReport(2000);
  h.record("thread-crash", { crashed, report: report ?? "none" });
  expect(crashed, "requests fail as crashed").toBe(true);
  expect(report, "the crash report").toMatch(/^a thread crashed: /);
  expect(report, "the crash report").not.toContain("never arrived");
  return report!;
};

// What the runtime prints of a thread that traps: Emscripten's report of it,
// on the host's thread, and, asserting, the trapping thread's own report
// and stack first. Chromium and Node name the trap "unreachable", Firefox
// "unreachable executed", and their stacks differ in form.
export const crashPrinted = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  if (runtime.name === "asserting") {
    await h.printed.take(
      /^worker: onmessage\(\) captured an uncaught exception: RuntimeError: unreachable( executed)?$/,
      { count: 1 },
    );
    await h.printed.take(/^RuntimeError: unreachable$|^ {4}at |^\S*@(https?|file):\/\//, { min: 2 });
  }
  await h.printed.take(/sent an error! .*unreachable( executed)?$/, { count: 1 });
};

// Whether a crash's report, or the output alongside it, is Emscripten's
// abort for a heap that can't hold an allocation. Built with exceptions in
// WebAssembly, Emscripten aborts by trapping, so its error is an
// "unreachable" trap like a program's own; only the frame it trapped from,
// or the abort's message where the output shows, tells them apart.
export const outOfMemoryAbort = /\babortOnCannotGrowMemory\b|Aborted\((OOM|Cannot enlarge memory)/;

// Emscripten's out-of-memory abort as the runtime prints it, with the
// asserting runtime's advice.
export const abortPrinted = /^Aborted\((OOM|Cannot enlarge memory arrays .*\(OOM\))/;

// An allocation the heap can't hold aborts the runtime, which never grows
// its memory: the request fails as crashed, and the host reports
// Emscripten's out-of-memory abort, not another trap. An allocation of all
// but a MiB of the most memory the runtime takes never fits, the runtime's
// own data taking more than that. Takes the host down, so it runs on a host
// of its own.
export const heapFull = async (h: Harness, { client }: RunningHost): Promise<string> => {
  const mib = h.data.constants.memory.maximum / MiB - 1;
  let crashed = false;
  try {
    await client.call(opsOf(h).memGrow, int32s(mib));
  } catch {
    crashed = true;
  }
  const report = await client.crashReport(2000);
  h.record("heap-full", { allocationMiB: mib, crashed, report: report?.split("\n")[0] ?? "none" });
  expect(crashed, "the request fails as crashed").toBe(true);
  expect(report, "the crash report").toMatch(outOfMemoryAbort);
  return report!;
};

// A memory workload: its threads run while the host sleeps, and its result
// comes once all have finished: every thread starts and finishes, finds
// nothing corrupt and gets every allocation, and none traps, at the
// planned thread count, in a memory that never grows.
const workload =
  (name: string, start: keyof Ops, result: keyof Ops, size: (stress: Harness["data"]["stress"]) => number) =>
  async (h: Harness, { client }: RunningHost): Promise<void> => {
    const ops = opsOf(h);
    const { stress } = h.data;
    const started = await call32(client, ops[start], int32s(stress.threads, size(stress)));
    const [, errors, outOfMemory, us, before, after] = (await poll(h, client, ops[result], 20)).values;
    // The allocator never gives memory back to the break, so where the
    // break ends is the heap's peak.
    const [, breakKiB] = replyInt32s(await client.call(ops.memInfo));
    h.record(name, {
      threads: started,
      elapsedMs: round(us! / 1000, 1),
      memoryMiB: [round(before! / 1024, 1), round(after! / 1024, 1)],
      breakMiB: round(breakKiB! / 1024, 1),
    });
    expect(started, "threads started").toBe(stress.threads);
    expect(errors, "corruption found").toBe(0);
    expect(outOfMemory, "allocations refused").toBe(0);
  };

// Without GLib: threads that each keep one more block of fresh memory a
// round, hand one to a neighbour, which increments a word of it atomically,
// and have JavaScript fill another.
export const memStress = workload("mem-stress", "memStress", "memStressResult", ({ rounds }) => rounds);

// GLib's 1bit-emufutex workload: threads, each from g_rand_new(), taking
// random bit locks over an emulated futex.
export const glibStress = workload("glib-stress", "glibStress", "glibStressResult", ({ iterations }) => iterations);
