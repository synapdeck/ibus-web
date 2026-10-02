// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The runtime spike's scenarios, each with its pass criterion and what it
// measures. They talk to a host only through a Client, so any harness that
// can post requests over the control buffer runs them.

import {
  HostOp,
  type BuildConstants,
  type HostMessage,
  type HostStats,
  type Mount,
  type Reply,
} from "./control.ts";

// The spike side modules' operations scenarios use, under their C names in
// camel case (SPIKE_OP_SPAWN_DETACHED is spawnDetached).
const opNames = [
  "add",
  "idleLater",
  "idleResult",
  "spawn",
  "spawnResult",
  "throw",
  "fsync",
  "fsyncResult",
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
  "writeFile",
  "readFile",
  "readFileRdwr",
  "hold",
  "release",
  "memStress",
  "memStressResult",
  "glibStress",
  "glibStressResult",
  "memInfo",
  "memGrow",
  "jsHeap",
  "listTree",
] as const;

export type Ops = Readonly<Record<(typeof opNames)[number], number>>;

// The opcodes the build printed, by the names scenarios use them under.
export const opsFrom = ({ ops }: BuildConstants): Ops => {
  const byName = new Map(
    Object.entries(ops).map(([name, opcode]) => [
      name
        .toLowerCase()
        .replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      opcode,
    ]),
  );
  const missing = opNames.filter((name) => !byName.has(name));
  if (missing.length > 0)
    throw new Error(`the build defines no opcode for ${missing.join(", ")}`);
  return Object.fromEntries(
    opNames.map((name) => [name, byName.get(name)!]),
  ) as Ops;
};

// A call whose reply came only after the client stopped waiting the way it
// must: it held its thread for heldMs, then let it go, and the reply came
// afterMs later.
export interface LateReply {
  opcode: number;
  heldMs: number;
  afterMs: number;
}

export interface Client {
  call(opcode: number, payload?: Uint8Array): Promise<Reply>;
  // The host's report of why it crashed, or null if none came within
  // timeoutMs.
  crashReport(timeoutMs: number): Promise<string | null>;
  // Late replies so far; each fails the scenario that made it.
  lateReplies?: readonly LateReply[];
  // How long each call so far that held its thread throughout held it, in
  // milliseconds.
  heldMs?: readonly number[];
}

export interface Env {
  // Milliseconds, from a monotonic clock.
  now(): number;
  sleep(ms: number): Promise<void>;
  utf8(text: string): Uint8Array;
  decode(bytes: Uint8Array): string;
  // Emscripten's errno values, by name.
  errno: Readonly<Record<string, number>>;
  ops: Ops;
  // The pthread pool's size at start; the threads its shares plan for, the
  // sum of the shares; the shares of the spike's side modules and of GLib,
  // which is what one GTask in flight keeps alive; and the spare Workers
  // beyond the shares, which the host tops the pool back up to.
  poolSize: number;
  plannedThreads: number;
  engineThreads: number;
  glibThreads: number;
  poolLowWater: number;
  // Files to fsync() from a thread, one per storage backend under test.
  fsyncPaths: readonly string[];
  // How long a result may stay pending before the scenario gives up on it.
  pendingLimitMs: number;
  // The longest cross-thread-wake may take, in milliseconds, if not its
  // default.
  wakeMaxMs?: number;
  // The most memory the runtime takes, in bytes.
  memoryMaximum?: number;
  // The memory the harness asked the host to make for the runtime, in bytes.
  memoryBytes?: number;
  // The engine's directory, what the host is to mount there, and the size
  // of the engine's data, the sum of its manifest's data[].size.
  engine?: { dir: string; mount: Mount; dataBytes: number };
  // The messages the host has posted to the harness so far, but "ready".
  hostMessages?: () => readonly HostMessage[];
  // Opens the engine's database at a newer version from the harness, as an
  // upgrade in another tab would, and closes it again; resolves once it
  // opened, with how long that took in milliseconds.
  upgradeDatabase?: () => Promise<number>;
  // The memory workloads' sizes: threads alive at once, mem-stress's rounds
  // per thread and glib-stress's lock takes per thread.
  stress?: { threads: number; rounds: number; iterations: number };
  // The memory the harness can see the runtime's process or processes use,
  // in MiB by what it measured.
  sampleMemory?: () => Promise<Record<string, number>>;
}

export type Measurement =
  number | string | boolean | readonly (number | string)[];

export interface Outcome {
  pass: boolean;
  measurements: Record<string, Measurement>;
}

export interface Scenario {
  name: string;
  criterion: string;
  // earlier: the results of the scenarios run before it on the same host.
  run(client: Client, env: Env, earlier: readonly Result[]): Promise<Outcome>;
}

export const int32s = (...values: number[]): Uint8Array =>
  new Uint8Array(new Int32Array(values).buffer);

export const replyInt32 = ({ ret, bytes }: Reply): number => {
  if (ret < 0) return ret;
  if (bytes.length !== 4)
    throw new Error(`a reply of ${bytes.length} bytes, not one int32`);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true);
};

// A reply's int32 values, or only its error.
export const replyInt32s = ({ ret, bytes }: Reply): number[] => {
  if (ret < 0) return [ret];
  if (bytes.length % 4 !== 0)
    throw new Error(`a reply of ${bytes.length} bytes, not int32s`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  return Array.from({ length: bytes.length / 4 }, (_, i) =>
    view.getInt32(i * 4, true),
  );
};

const call32 = async (
  client: Client,
  opcode: number,
  payload?: Uint8Array,
): Promise<number> => replyInt32(await client.call(opcode, payload));

const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ??
  Number.NaN;

const round = (value: number, digits = 3): number =>
  Number(value.toFixed(digits));

// Asks for a result every intervalMs until it is no longer -EAGAIN, or
// null once env.pendingLimitMs has passed. value is the reply's first int32.
const poll = async (
  client: Client,
  env: Env,
  opcode: number,
  intervalMs = 2,
): Promise<{ value: number; values: number[]; ms: number } | null> => {
  const start = env.now();
  for (;;) {
    const values = replyInt32s(await client.call(opcode));
    const value = values[0]!;
    const ms = env.now() - start;
    if (value !== -env.errno.EAGAIN!) return { value, values, ms };
    if (ms > env.pendingLimitMs) return null;
    await env.sleep(intervalMs);
  }
};

// Returns the host to its event loop for a moment.
const hostYield = async (client: Client): Promise<void> => {
  const { ret } = await client.call(HostOp.yield);
  if (ret !== 0) throw new Error(`host yield: ${ret}`);
};

const setTopUps = async (client: Client, allowed: boolean): Promise<void> => {
  const { ret } = await client.call(HostOp.topUp, int32s(allowed ? 1 : 0));
  if (ret !== 0) throw new Error(`host top-up: ${ret}`);
};

const stats = async (client: Client, env: Env): Promise<HostStats> => {
  const { ret, bytes } = await client.call(HostOp.stats);
  if (ret < 0) throw new Error(`host stats: ${ret}`);
  return JSON.parse(env.decode(bytes)) as HostStats;
};

// Creates n threads that keep their Workers until release().
const hold = async (client: Client, env: Env, n: number): Promise<void> => {
  const [held, error] = replyInt32s(await client.call(env.ops.hold, int32s(n)));
  if (held !== n || error !== 0)
    throw new Error(`hold(${n}): ${held} held, error ${error}`);
};

const release = async (client: Client, env: Env): Promise<void> => {
  const released = await call32(client, env.ops.release);
  if (released < 0) throw new Error(`release: ${released}`);
};

// Stats once the host has finished a top-up after since, or the latest
// stats if none finishes within env.pendingLimitMs. A request would wait
// out a top-up's new Worker() calls in Firefox, where they return only
// while the page's thread is free, so the first waits a moment.
const awaitTopUp = async (
  client: Client,
  env: Env,
  since: HostStats,
): Promise<HostStats> => {
  const deadline = env.now() + env.pendingLimitMs;
  await env.sleep(50);
  let latest = await stats(client, env);
  while (latest.topUps === since.topUps && env.now() < deadline) {
    await env.sleep(5);
    latest = await stats(client, env);
  }
  return latest;
};

// Round trips of add, each with its sum checked, in microseconds.
const addRoundTrips = async (
  client: Client,
  env: Env,
  rounds: number,
  gapMs: number,
): Promise<{ times: number[]; wrong: number }> => {
  const times: number[] = [];
  let wrong = 0;
  for (let i = 0; i < rounds; i++) {
    if (gapMs > 0) await env.sleep(gapMs);
    const start = env.now();
    const sum = await call32(client, env.ops.add, int32s(i, 1000));
    times.push((env.now() - start) * 1000);
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

// Back to back, the next request often lands before the host has gone back
// to sleep, so these times mix requests served at once with ones that woke
// the host; requestsWhileAsleep says how many of each. A browser's clock
// steps in tens of microseconds, about a round trip, so each batch of
// requests is also timed whole, between two readings, for a mean finer than
// the step.
export const dispatch: Scenario = {
  name: "dispatch",
  criterion: "1000 add round trips back to back, every sum right",
  async run(client, env) {
    const batches = 10;
    const perBatch = 100;
    const before = await stats(client, env);
    const times: number[] = [];
    const means: number[] = [];
    let wrong = 0;
    for (let b = 0; b < batches; b++) {
      const start = env.now();
      const batch = await addRoundTrips(client, env, perBatch, 0);
      means.push(((env.now() - start) * 1000) / perBatch);
      times.push(...batch.times);
      wrong += batch.wrong;
    }
    const after = await stats(client, env);
    times.sort((a, b) => a - b);
    means.sort((a, b) => a - b);
    return {
      pass: wrong === 0,
      measurements: {
        wrong,
        ...latencies(times),
        batchMeanUs: round(percentile(means, 50), 2),
        batchMeanRangeUs: [round(means[0]!, 2), round(means.at(-1)!, 2)],
        requestsWhileAsleep: `${after.requestsWhileAsleep - before.requestsWhileAsleep} of ${after.requests - before.requests}`,
      },
    };
  },
};

// Each request should find the host asleep, so the round trip pays the
// whole wake path: in "runtime" mode the relay's hop and the host's, in "control"
// mode the host's alone. The gap before each request has to pass with the
// host asleep, so a batch can't be timed whole without timing the gaps on
// the same coarse clock. Each request starts after a timer, at no
// particular point of the clock's step, so each time is off by under a step
// either way, evenly, and their mean is finer than the step. A host
// descheduled on a loaded machine can still be awake when a request lands,
// which only shortens that round trip, so a few such requests are allowed.
const coldWake: Scenario = {
  name: "cold-wake",
  criterion:
    "300 add round trips, each sent 2 ms after the last reply: every sum right, and at least 95% found the host asleep",
  async run(client, env) {
    const gapMs = 2;
    const before = await stats(client, env);
    const { times, wrong } = await addRoundTrips(client, env, 300, gapMs);
    await env.sleep(gapMs);
    const after = await stats(client, env);
    const requests = after.requests - before.requests;
    const asleep = after.requestsWhileAsleep - before.requestsWhileAsleep;
    return {
      pass: wrong === 0 && asleep >= requests * 0.95,
      measurements: {
        wrong,
        ...latencies(times),
        meanUs: round(times.reduce((sum, t) => sum + t, 0) / times.length, 2),
        requestsWhileAsleep: `${asleep} of ${requests}`,
      },
    };
  },
};

// The host gets no request while the source is pending, so only GLib's
// wake can get it dispatched. The first poll's request wakes the host too,
// so it waits until a source left for that would be later than the bound:
// a wake that never arrives still fails. The median holds the wake to its
// usual cost; the bound is generous, as a host on a machine loaded with
// other builds is descheduled now and then.
const crossThreadWake: Scenario = {
  name: "cross-thread-wake",
  criterion:
    "idle-later(50) ×20 with the host idle: attach to dispatch p50 ≤ 20 ms, and every time " +
    "within the run's bound (200 ms; 20 ms by hand)",
  async run(client, env): Promise<Outcome> {
    const bound = env.wakeMaxMs ?? 200;
    const epsilons: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = await call32(client, env.ops.idleLater, int32s(50));
      if (started !== 0) throw new Error(`idle-later: ${started}`);
      await env.sleep(50 + bound + 150);
      const result = await poll(client, env, env.ops.idleResult);
      if (result === null)
        return {
          pass: false,
          measurements: { epsilonsMs: epsilons, pending: true },
        };
      epsilons.push(result.value / 1000);
    }
    const sorted = [...epsilons].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const max = sorted.at(-1) ?? Number.NaN;
    return {
      pass: (sorted[0] ?? Number.NaN) >= 0 && p50 <= 20 && max <= bound,
      measurements: {
        p50Ms: round(p50),
        maxMs: round(max),
        minMs: round(sorted[0] ?? Number.NaN),
        boundMs: bound,
      },
    };
  },
};

const deadline: Scenario = {
  name: "deadline",
  criterion:
    "g_timeout_add(100) ×5 with no requests: dispatched at 100 ± 10 ms every time",
  async run(client, env): Promise<Outcome> {
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = await call32(client, env.ops.timeout, int32s(100));
      if (started !== 0) throw new Error(`timeout: ${started}`);
      await env.sleep(300);
      const result = await poll(client, env, env.ops.timeoutResult);
      if (result === null)
        return {
          pass: false,
          measurements: { delaysMs: delays, pending: true },
        };
      delays.push(round(result.value / 1000));
    }
    const worst = Math.max(...delays.map((ms) => Math.abs(ms - 100)));
    return {
      pass: worst <= 10,
      measurements: { delaysMs: delays, worstDeviationMs: round(worst) },
    };
  },
};

// A burst the pool covers: every thread starts on a Worker that has already
// loaded, so nothing waits for the host's event loop.
const threadCreateBlocked: Scenario = {
  name: "thread-create-blocked",
  criterion:
    "a burst of the side modules' share of threads alive at once, spawn(share) from a pump " +
    "and spawn-nested(share - 1) from a thread, whose creations the host runs while it sleeps, " +
    "starts and joins every thread, creating no Worker and never returning the host to its event loop",
  async run(client, env) {
    const n = env.engineThreads;
    const before = await stats(client, env);
    const measurements: Record<string, Measurement> = {
      engineThreads: n,
      idleWorkers: `${before.idleWorkers} of a pool of ${env.poolSize}`,
    };
    if (before.idleWorkers < n)
      return { pass: false, measurements: { ...measurements, short: true } };
    let pass = true;
    const burst = async (
      label: string,
      start: number,
      result: number,
      threads: number,
    ): Promise<void> => {
      const first = await stats(client, env);
      const startedAt = env.now();
      const started = await call32(client, start, int32s(threads));
      if (started !== 0) throw new Error(`${label}: ${started}`);
      const joined = await poll(client, env, result);
      const ms = env.now() - startedAt;
      const last = await stats(client, env);
      if (joined === null) {
        measurements[label] = "hung";
        pass = false;
        return;
      }
      const [count, error] = joined.values;
      const created = last.workersCreated - first.workersCreated;
      const turns = last.eventLoopTurns - first.eventLoopTurns;
      measurements[label] =
        `joined ${count} in ${round(ms, 1)} ms, error ${error}, ` +
        `${created} Workers created, ${turns} event-loop turns`;
      if (count !== threads || error !== 0 || created !== 0 || turns !== 0)
        pass = false;
    };
    await burst("spawn", env.ops.spawn, env.ops.spawnResult, n);
    // The thread doing the creating is one of the burst.
    await burst(
      "nested",
      env.ops.spawnNested,
      env.ops.spawnNestedResult,
      n - 1,
    );
    return { pass, measurements };
  },
};

// The pool's Workers: those it started with, plus those created since, by
// top-ups or, under Node, by Emscripten itself.
const poolWorkers = (env: Env, { workersCreated }: HostStats): number =>
  env.poolSize + workersCreated;

const threadsAlive = (env: Env, at: HostStats): number =>
  poolWorkers(env, at) - at.idleWorkers;

// The pool starts with poolLowWater Workers beyond the threads its shares
// plan for, so a peak within the shares leaves that many idle and the host
// has no reason to top up; one thread more leaves one fewer. The host
// decides as soon as it has answered a request, and a top-up it starts
// creates its Workers and counts an event-loop turn at once. This runs
// before any other scenario leaves a thread alive or grows the pool, though
// it counts what is alive rather than relying on that.
const poolTopUp: Scenario = {
  name: "pool-top-up",
  criterion:
    "with as many threads alive as the shares plan for and the host idle, the host leaves the " +
    "pool as it is, with its spare Workers idle; with one more alive, it tops the pool up by one " +
    "Worker, back to its low-water mark of idle Workers, by itself",
  async run(client, env) {
    const measurements: Record<string, Measurement> = {};
    let pass = true;
    const expect = (label: string, ok: boolean, value: Measurement): void => {
      measurements[label] = value;
      if (!ok) pass = false;
    };
    const planned = env.plannedThreads;
    const describe = (at: HostStats, since: HostStats): string =>
      `${threadsAlive(env, at)} threads alive, ${at.idleWorkers} of ` +
      `${poolWorkers(env, at)} Workers idle; ${at.workersCreated - since.workersCreated} ` +
      `Workers created, ${at.topUps - since.topUps} top-ups, ` +
      `${at.eventLoopTurns - since.eventLoopTurns} event-loop turns`;

    const first = await stats(client, env);
    const toPeak = planned - threadsAlive(env, first);
    if (toPeak < 1)
      throw new Error(
        `${threadsAlive(env, first)} threads alive already, of ${planned} planned`,
      );
    await hold(client, env, toPeak);
    // Time for a top-up's new Worker() calls to return, in Firefox too,
    // where they wait for the page's thread.
    await env.sleep(50);
    const peak = await stats(client, env);
    expect(
      "plannedPeak",
      threadsAlive(env, peak) === planned &&
        peak.idleWorkers === env.poolLowWater &&
        peak.workersCreated === first.workersCreated &&
        peak.topUps === first.topUps &&
        peak.eventLoopTurns === first.eventLoopTurns,
      describe(peak, first),
    );
    await release(client, env);

    const before = await stats(client, env);
    await hold(client, env, toPeak + 1);
    const over = await awaitTopUp(client, env, before);
    expect(
      "overshoot",
      threadsAlive(env, over) === planned + 1 &&
        over.idleWorkers === env.poolLowWater &&
        over.topUps === before.topUps + 1 &&
        over.topUpWorkers - before.topUpWorkers === 1 &&
        over.workersCreated - before.workersCreated === 1,
      describe(over, before) +
        (over.topUps === before.topUps
          ? ""
          : `; the top-up took ${round(over.lastTopUpMs!, 1)} ms`),
    );
    await release(client, env);
    return { pass, measurements };
  },
};

// Exceeding the pool fails pthread_create() with EAGAIN, which GLib's
// g_thread_try_new() reports as G_THREAD_ERROR_AGAIN, rather than waiting for
// a Worker that can't start; hold() takes Workers so that the pool runs out
// while top-ups are held off. Under Node, Emscripten creates a Worker
// instead, so this runs in browsers only. The idle count it reads first must
// hold throughout: sync-proxied's GTask worker, if that ran, stays alive
// some 15.5 s after its task, against about 0.1 s from there to here.
export const poolExhausted: Scenario = {
  name: "pool-exhausted",
  criterion:
    "with every idle Worker taken and top-ups held off, a thread created from a pump and one " +
    "created from another thread (proxied to the host) fail with EAGAIN at once, and the host " +
    "keeps answering; with top-ups allowed again, the host restores the pool's low-water mark " +
    "of idle Workers by itself, and a burst of that many starts on them",
  async run(client, env) {
    const measurements: Record<string, Measurement> = {};
    let pass = true;
    const expect = (label: string, ok: boolean, value: Measurement): void => {
      measurements[label] = value;
      if (!ok) pass = false;
    };
    const attempt = async (start: number, result: number, n: number) => {
      const startedAt = env.now();
      const started = await call32(client, start, int32s(n));
      const outcome = started === 0 ? await poll(client, env, result) : null;
      return {
        started,
        joined: outcome?.values[0],
        error: outcome?.values[1],
        ms: round(env.now() - startedAt, 2),
      };
    };
    const eagain = -env.errno.EAGAIN!;

    await setTopUps(client, false);
    const first = await stats(client, env);
    const idle = first.idleWorkers;
    measurements.idleWorkers = idle;

    await hold(client, env, idle);
    const fromPump = await attempt(env.ops.spawn, env.ops.spawnResult, 1);
    expect(
      "fromPump",
      fromPump.joined === 0 && fromPump.error === eagain,
      `joined ${fromPump.joined}, error ${fromPump.error}, in ${fromPump.ms} ms`,
    );
    await release(client, env);

    // The creating thread takes the last idle Worker itself.
    await hold(client, env, idle - 1);
    const proxied = await attempt(
      env.ops.spawnNested,
      env.ops.spawnNestedResult,
      1,
    );
    expect(
      "proxied",
      proxied.joined === 0 && proxied.error === eagain,
      `joined ${proxied.joined}, error ${proxied.error}, in ${proxied.ms} ms`,
    );
    await release(client, env);
    const answering = await call32(client, env.ops.add, int32s(2, 3));
    expect("addAfter", answering === 5, answering);

    await hold(client, env, idle);
    const emptied = await stats(client, env);
    await setTopUps(client, true);
    const topped = await awaitTopUp(client, env, emptied);
    const lowWater = topped.topUpWorkers - emptied.topUpWorkers;
    expect(
      "topUp",
      topped.topUps === emptied.topUps + 1 &&
        lowWater > 0 &&
        topped.idleWorkers === lowWater,
      topped.topUps === emptied.topUps
        ? "none"
        : `${lowWater} Workers in ${round(topped.lastTopUpMs!, 1)} ms ` +
            `(new Worker() ${round(topped.lastTopUpCreateMs!, 2)} ms); ${topped.idleWorkers} idle`,
    );
    const burst = await attempt(env.ops.spawn, env.ops.spawnResult, lowWater);
    const last = await stats(client, env);
    expect(
      "burstAfterTopUp",
      burst.joined === lowWater &&
        burst.error === 0 &&
        last.workersCreated === topped.workersCreated,
      `joined ${burst.joined}, error ${burst.error}, in ${burst.ms} ms, ` +
        `${last.workersCreated - topped.workersCreated} Workers created`,
    );
    await release(client, env);
    expect(
      "workersCreated",
      last.workersCreated - first.workersCreated === lowWater,
      last.workersCreated - first.workersCreated,
    );
    return { pass, measurements };
  },
};

const MiB = 2 ** 20;

// A detached thread ends without a join on the host's thread, as GLib's
// pool workers do. Rounds of them, the host never returning to its event
// loop.
const threadExitBlocked: Scenario = {
  name: "thread-exit-blocked",
  criterion:
    "5 rounds of spawn-detached(the side modules' share) with the host never returning to its event loop: " +
    "heap in use after each round within 0.5 MiB of the first round's, no Worker created " +
    "in a round that began with enough idle Workers, and nothing left for the event loop to reclaim",
  async run(client, env): Promise<Outcome> {
    const n = env.engineThreads;
    const idle: number[] = [];
    const created: number[] = [];
    const heap: number[] = [];
    let pass = true;
    for (let i = 0; i < 5; i++) {
      const before = await stats(client, env);
      const started = await call32(client, env.ops.spawnDetached, int32s(n));
      if (started !== n) throw new Error(`spawn-detached: ${started}`);
      const reported = await poll(client, env, env.ops.spawnDetachedResult);
      if (reported === null)
        return {
          pass: false,
          measurements: { hungInRound: i + 1 },
        };
      // Let the threads finish exiting.
      await env.sleep(50);
      const after = await stats(client, env);
      idle.push(before.idleWorkers);
      created.push(after.workersCreated - before.workersCreated);
      heap.push(after.heapInUse);
      if (before.idleWorkers >= n && created.at(-1) !== 0) pass = false;
    }
    const first = heap[0]!;
    if (heap.some((bytes) => Math.abs(bytes - first) > MiB / 2)) pass = false;
    await hostYield(client);
    const afterYield = (await stats(client, env)).heapInUse;
    if (heap.at(-1)! - afterYield > MiB / 2) pass = false;
    return {
      pass,
      measurements: {
        idleWorkersBefore: idle,
        workersCreated: created,
        heapInUseMiB: heap.map((bytes) => round(bytes / MiB, 2)),
        afterYieldHeapInUseMiB: round(afterYield / MiB, 2),
      },
    };
  },
};

const syncProxied: Scenario = {
  name: "sync-proxied",
  criterion:
    "while the host sleeps: a call proxied synchronously to its thread, a thread creating threads, " +
    "and a GTask a thread starts in GLib's thread pool all complete",
  async run(client, env) {
    const measurements: Record<string, Measurement> = {};
    let pass = true;
    // Each result is microseconds to completion, or the count joined when
    // expected is given.
    const check = async (
      label: string,
      start: number,
      payload: Uint8Array | undefined,
      result: number,
      expected?: number,
    ) => {
      const started = await call32(client, start, payload);
      if (started !== 0) throw new Error(`${label}: ${started}`);
      const outcome = await poll(client, env, result);
      if (outcome === null) {
        pass = false;
        measurements[label] = `pending after ${env.pendingLimitMs} ms`;
      } else if (
        outcome.value < 0 ||
        (expected !== undefined && outcome.value !== expected)
      ) {
        pass = false;
        measurements[label] = `failed: ${outcome.value}`;
      } else {
        measurements[label] = outcome.value;
      }
    };
    await check(
      "proxySyncUs",
      env.ops.proxySync,
      undefined,
      env.ops.proxySyncResult,
    );
    await check(
      "spawnNestedJoined",
      env.ops.spawnNested,
      int32s(2),
      env.ops.spawnNestedResult,
      2,
    );
    // GLib starts the threads of its pool for GTasks as the first is run,
    // and keeps them: the spawner for good, the worker for a while. One
    // GTask in flight is what GLib's share of the pool is sized for.
    const before = await stats(client, env);
    await check("taskUs", env.ops.task, undefined, env.ops.taskResult);
    // Lets the thread that started the task end.
    await env.sleep(50);
    const after = await stats(client, env);
    const kept = before.idleWorkers - after.idleWorkers;
    measurements.workersKeptAfterTask = kept;
    measurements.glibThreads = env.glibThreads;
    if (kept !== env.glibThreads) pass = false;
    return { pass, measurements };
  },
};

export const promiseProxiedFsync: Scenario = {
  name: "promise-proxied-fsync",
  criterion:
    "fsync() from a thread while the host sleeps completes on every storage backend",
  async run(client, env) {
    const measurements: Record<string, Measurement> = {};
    let pass = true;
    for (const path of env.fsyncPaths) {
      const bytes = env.utf8(path);
      const started = await call32(client, env.ops.fsync, bytes);
      if (started !== 0) throw new Error(`fsync(${path}): ${started}`);
      const result = await poll(client, env, env.ops.fsyncResult);
      if (result === null || result.value !== bytes.length) pass = false;
      measurements[path] =
        result === null
          ? "pending"
          : result.value === bytes.length
            ? `ok in ${round(result.ms, 1)} ms`
            : result.value;
    }
    return { pass, measurements };
  },
};

const exceptions: Scenario = {
  name: "exceptions",
  criterion: "throw replies -ECANCELED, then add still works",
  async run(client, env) {
    const thrown = await call32(client, env.ops.throw);
    const after = await call32(client, env.ops.add, int32s(1, 1));
    return {
      pass: thrown === -env.errno.ECANCELED! && after === 2,
      measurements: { throwReply: thrown, addAfter: after },
    };
  },
};

// A read-file reply: the file's size, then its contents.
export const replyFile = (
  { ret, bytes }: Reply,
  env: Env,
): { status: number; text?: string } => {
  if (ret < 0) return { status: ret };
  const status = replyInt32({ ret: 4, bytes: bytes.subarray(0, 4) });
  return status < 0
    ? { status }
    : { status, text: env.decode(bytes.subarray(4)) };
};

const WASM_PAGE = 65536;

const engineOf = (env: Env): NonNullable<Env["engine"]> => {
  if (env.engine === undefined)
    throw new Error("the harness names no engine directory");
  return env.engine;
};

// Writes a file new to the engine's directory, then reads it back through a
// side module's reads, opened read-only and for reading and writing. A name
// of its own keeps hosts that share the directory, as Node's do, apart.
const roundTrip = async (
  client: Client,
  env: Env,
): Promise<{ pass: boolean; measurements: Record<string, Measurement> }> => {
  const { dir } = engineOf(env);
  const path = `${dir}/roundtrip-${Math.random().toString(36).slice(2)}.txt`;
  const contents = `written to ${path} by the runtime`;
  const read = async (opcode: number) =>
    replyFile(await client.call(opcode, env.utf8(path)), env);
  const before = await read(env.ops.readFile);
  const writeAt = env.now();
  // write-file creates the file, writes it, fsync()s and closes it.
  const written = await call32(
    client,
    env.ops.writeFile,
    env.utf8(`${path}\0${contents}`),
  );
  const writeMs = env.now() - writeAt;
  const readAt = env.now();
  const readOnly = await read(env.ops.readFile);
  const readMs = env.now() - readAt;
  const readWrite = await read(env.ops.readFileRdwr);
  const same = (got: { status: number; text?: string }): Measurement =>
    got.text === contents ? "same" : (got.text ?? got.status);
  return {
    pass:
      before.status === -env.errno.ENOENT! &&
      written === env.utf8(contents).length &&
      readOnly.text === contents &&
      readWrite.text === contents,
    measurements: {
      before: before.status,
      written,
      writeAndFsyncMs: round(writeMs, 2),
      readOnly: same(readOnly),
      readMs: round(readMs, 2),
      readWrite: same(readWrite),
    },
  };
};

export const storageRoundtrip: Scenario = {
  name: "storage-roundtrip",
  criterion:
    "the engine's directory is mounted on the backend the harness expects, and a file absent " +
    "at first, written and fsync()ed on the host's thread, reads back the same through a side " +
    "module, opened read-only and for reading and writing",
  async run(client, env) {
    const { mount } = engineOf(env);
    const at = await stats(client, env);
    const { pass, measurements } = await roundTrip(client, env);
    return {
      pass: pass && at.mount === mount && !at.storageClosed,
      measurements: {
        mount: at.mount,
        expected: mount,
        storageClosed: at.storageClosed,
        idleWorkers: `${at.idleWorkers} of a pool of ${env.poolSize}`,
        ...measurements,
      },
    };
  },
};

// Runs first on a host of its own, started without IndexedDB, so that no
// thread is alive yet.
export const storageFallback: Scenario = {
  name: "storage-fallback",
  criterion:
    "a host that can't open IndexedDB mounts WasmFS's memory backend at the engine's " +
    "directory, which starts no thread, makes the runtime's memory larger by the engine " +
    "data's size in whole pages, and reports storage: ephemeral; a file written there reads back",
  async run(client, env) {
    const { dataBytes } = engineOf(env);
    if (env.memoryBytes === undefined || env.hostMessages === undefined)
      throw new Error(
        "the harness gives neither the memory nor the host's messages",
      );
    const at = await stats(client, env);
    const expectedBytes =
      env.memoryBytes + Math.ceil(dataBytes / WASM_PAGE) * WASM_PAGE;
    const events = env
      .hostMessages()
      .filter((message) => message.type === "storage");
    const ephemeral = events.filter(({ state }) => state === "ephemeral");
    const { pass, measurements } = await roundTrip(client, env);
    return {
      pass:
        pass &&
        at.mount === "memory" &&
        at.memoryBytes === expectedBytes &&
        at.idleWorkers === env.poolSize &&
        ephemeral.length === 1 &&
        events.length === 1,
      measurements: {
        mount: at.mount,
        memoryBytes: at.memoryBytes,
        expectedMemoryBytes: expectedBytes,
        idleWorkers: `${at.idleWorkers} of a pool of ${env.poolSize}`,
        storageEvents: events.map(
          ({ state, message }) => `${state}: ${message}`,
        ),
        ...measurements,
      },
    };
  },
};

// Leaves the engine's storage failing, so it runs on a host of its own.
export const storageClosed: Scenario = {
  name: "storage-closed",
  criterion:
    "when another connection opens the engine's database at a newer version, the IndexedDB " +
    "backend's connection closes for it: a file created in the engine's directory then fails " +
    "with EIO, and the host reports storage: closed",
  async run(client, env) {
    const { dir } = engineOf(env);
    const { upgradeDatabase, hostMessages } = env;
    if (upgradeDatabase === undefined || hostMessages === undefined)
      throw new Error(
        "the harness can neither upgrade the database nor give the host's messages",
      );
    const before = await stats(client, env);
    const upgradeMs = await upgradeDatabase();
    const written = await call32(
      client,
      env.ops.writeFile,
      env.utf8(`${dir}/after-close.txt\0closed`),
    );
    const after = await stats(client, env);
    // The host posts its report when it wakes for a request; this thread
    // receives it once its event loop runs, so poll for it.
    const storageEvents = () =>
      hostMessages().filter((message) => message.type === "storage");
    const deadline = Date.now() + 2000;
    while (storageEvents().length === 0 && Date.now() < deadline)
      await env.sleep(10);
    const events = storageEvents();
    return {
      pass:
        before.mount === "indexeddb" &&
        !before.storageClosed &&
        after.storageClosed &&
        written === -env.errno.EIO! &&
        events.length === 1 &&
        events[0]!.state === "closed",
      measurements: {
        closedBefore: before.storageClosed,
        upgradeMs: round(upgradeMs, 2),
        written,
        closedAfter: after.storageClosed,
        storageEvents: events.map(
          ({ state, message }) => `${state}: ${message}`,
        ),
      },
    };
  },
};

// Takes the host down, so it runs on a host of its own.
export const threadCrash: Scenario = {
  name: "thread-crash",
  criterion:
    "a thread that traps takes the host down: requests fail as crashed, and the host reports " +
    "that thread's error, not only Emscripten's unwinding of the host",
  async run(client, env) {
    const started = await call32(client, env.ops.crashThread);
    if (started !== 0) throw new Error(`crash-thread: ${started}`);
    const deadline = env.now() + env.pendingLimitMs;
    let crashed = false;
    while (!crashed && env.now() < deadline) {
      try {
        await client.call(env.ops.add, int32s(1, 1));
        await env.sleep(10);
      } catch {
        crashed = true;
      }
    }
    const report = await client.crashReport(2000);
    return {
      pass:
        crashed &&
        report !== null &&
        report.startsWith("a thread crashed: ") &&
        !report.includes("never arrived"),
      measurements: { crashed, report: report ?? "none" },
    };
  },
};

// Whether a crash's report, or the output alongside it, is Emscripten's
// abort for a heap that can't hold an allocation. Built with exceptions in
// WebAssembly, Emscripten aborts by trapping, so its error is an
// "unreachable" trap like a program's own; only the frame it trapped from,
// or the abort's message where the output shows, tells them apart.
export const outOfMemoryAbort = (text: string): boolean =>
  /\babortOnCannotGrowMemory\b|Aborted\((OOM|Cannot enlarge memory)/.test(text);

// Takes the host down, so it runs on a host of its own. An allocation of
// all but a MiB of the most memory the runtime takes never fits, the
// runtime's own data taking more than that.
export const heapFull: Scenario = {
  name: "heap-full",
  criterion:
    "an allocation the heap can't hold aborts the runtime, which never grows its memory: the " +
    "request fails as crashed, and the host reports Emscripten's out-of-memory abort, not " +
    "another trap",
  async run(client, env) {
    if (env.memoryMaximum === undefined)
      throw new Error("heap-full needs the most memory the runtime takes");
    const mib = env.memoryMaximum / (1024 * 1024) - 1;
    let crashed = false;
    try {
      await client.call(env.ops.memGrow, int32s(mib));
    } catch {
      crashed = true;
    }
    const report = await client.crashReport(2000);
    return {
      pass: crashed && report !== null && outOfMemoryAbort(report),
      measurements: {
        allocationMiB: mib,
        crashed,
        report: report?.split("\n")[0] ?? "none",
        outOfMemory: report !== null && outOfMemoryAbort(report),
      },
    };
  },
};

const KiB = 1024;

const stressOf = (env: Env): NonNullable<Env["stress"]> => {
  if (env.stress === undefined)
    throw new Error("the memory scenarios need the workloads' sizes");
  return env.stress;
};

// A memory workload: its threads run while the host sleeps, and its result
// comes once all have finished. A thread that traps takes the host down,
// which fails the scenario with the host's report.
const workload = (
  name: string,
  what: string,
  start: (ops: Ops) => number,
  result: (ops: Ops) => number,
  size: (stress: NonNullable<Env["stress"]>) => number,
): Scenario => ({
  name,
  criterion:
    `${what}: every thread starts and finishes, finds nothing corrupt and gets every allocation, ` +
    "and none traps",
  async run(client, env): Promise<Outcome> {
    const stress = stressOf(env);
    const started = await call32(
      client,
      start(env.ops),
      int32s(stress.threads, size(stress)),
    );
    if (started < 0) throw new Error(`${name}: ${started}`);
    const outcome = await poll(client, env, result(env.ops), 20);
    if (outcome === null)
      return {
        pass: false,
        measurements: { started, pendingAfterMs: env.pendingLimitMs },
      };
    const [, errors, outOfMemory, us, before, after] = outcome.values;
    // The allocator never gives memory back to the break, so where the
    // break ends is the heap's peak.
    const [, breakKiB] = replyInt32s(await client.call(env.ops.memInfo));
    return {
      pass: started === stress.threads && errors === 0 && outOfMemory === 0,
      measurements: {
        threads: started,
        errors: errors!,
        outOfMemory: outOfMemory!,
        elapsedMs: round(us! / 1000, 1),
        memoryMiB: [round(before! / KiB, 1), round(after! / KiB, 1)],
        breakMiB: round(breakKiB! / KiB, 1),
      },
    };
  },
});

export const memStress = workload(
  "mem-stress",
  "without GLib, threads that each keep one more block of fresh memory a round, hand one to a " +
    "neighbour, which increments a word of it atomically, and have JavaScript fill another",
  (ops) => ops.memStress,
  (ops) => ops.memStressResult,
  ({ rounds }) => rounds,
);

export const glibStress = workload(
  "glib-stress",
  "GLib's 1bit-emufutex workload: threads, each from g_rand_new(), taking random bit locks over an " +
    "emulated futex",
  (ops) => ops.glibStress,
  (ops) => ops.glibStressResult,
  ({ iterations }) => iterations,
);

// What growing costs, on a host that hasn't grown yet: the first
// allocation that outgrows the memory, then the same allocation again,
// which the memory now holds; and JavaScript's writes into the memory, which
// a build that grows memory without growable buffers checks its view for
// first.
export const memoryCosts: Scenario = {
  name: "memory-costs",
  criterion: "every allocation and call succeeds",
  async run(client, env) {
    const info = replyInt32s(await client.call(env.ops.memInfo));
    const grow = async (mib: number): Promise<number[]> => {
      const values = replyInt32s(
        await client.call(env.ops.memGrow, int32s(mib)),
      );
      if (values[0]! < 0) throw new Error(`mem-grow(${mib}): ${values[0]}`);
      return values;
    };
    const describe = ([allocUs, touchUs, before, after]: number[]): string =>
      `alloc ${allocUs} µs, touch ${touchUs} µs, memory ${round(before! / KiB, 1)} → ${round(after! / KiB, 1)} MiB`;
    const first = await grow(64);
    const again = await grow(64);
    const calls = 10_000;
    const jsUs = await call32(client, env.ops.jsHeap, int32s(calls));
    if (jsUs < 0) throw new Error(`js-heap: ${jsUs}`);
    return {
      pass: true,
      measurements: {
        startMemoryMiB: round(info[0]! / KiB, 1),
        startBreakMiB: round(info[1]! / KiB, 1),
        grow64MiB: describe(first),
        again64MiB: describe(again),
        getentropy64BytesNs: round((jsUs * 1000) / calls, 1),
      },
    };
  },
};

// What a pool Worker costs: the memory the harness sees grow as the host adds
// Workers to its pool, each instantiating the runtime, then as each of them
// runs a first thread, which loads the side modules into it.
export const workerMemory: Scenario = {
  name: "worker-memory",
  criterion: "the host adds Workers to its pool, and a thread runs on each",
  async run(client, env) {
    if (env.sampleMemory === undefined)
      throw new Error("the harness can't measure memory");
    const added = 20;
    await setTopUps(client, false);
    const before = await env.sampleMemory();
    const { ret } = await client.call(HostOp.addWorkers, int32s(added));
    if (ret !== 0) throw new Error(`host add-workers: ${ret}`);
    const loaded = await env.sampleMemory();
    // Emscripten hands out the Workers added last first, so these threads
    // run on the added ones.
    await hold(client, env, added);
    await release(client, env);
    const ran = await env.sampleMemory();
    await setTopUps(client, true);
    const per = (
      from: Record<string, number>,
      to: Record<string, number>,
      n: number,
    ): Record<string, number> =>
      Object.fromEntries(
        Object.keys(to)
          .filter((key) => key in from)
          .map((key) => [key, round((to[key]! - from[key]!) / n, 1)]),
      );
    return {
      pass: true,
      measurements: {
        added,
        beforeMiB: JSON.stringify(before),
        perAddedWorkerMiB: JSON.stringify(per(before, loaded, added)),
        perFirstThreadMiB: JSON.stringify(per(loaded, ran, added)),
      },
    };
  },
};

// thread-create-blocked runs before any other scenario starts a thread, so
// the pool holds only the Workers it started with.
export const scenarios: readonly Scenario[] = [
  dispatch,
  coldWake,
  threadCreateBlocked,
  poolTopUp,
  threadExitBlocked,
  crossThreadWake,
  deadline,
  syncProxied,
  promiseProxiedFsync,
  storageRoundtrip,
  exceptions,
];

export interface Result extends Outcome {
  name: string;
  criterion: string;
  error?: string;
  // When late replies failed a scenario that would otherwise have passed or
  // failed on its own: which way, and the replies.
  passWithoutLateReplies?: boolean;
  lateReplies?: LateReply[];
}

// The page's synchronous path holds its thread for a reply at most this
// long, then consumes the request and replays it asynchronously; each
// result counts the calls that held their thread longer.
export const REPLAY_BUDGET_MS = 40;

const heldSummary = (held: readonly number[]): string => {
  const over = held.filter((ms) => ms > REPLAY_BUDGET_MS).length;
  const longest = held.reduce((max, ms) => Math.max(max, ms), 0);
  return `${held.length} calls, ${over} over ${REPLAY_BUDGET_MS} ms; longest ${round(longest, 2)} ms`;
};

export const runScenarios = async (
  client: Client,
  env: Env,
  selected: readonly Scenario[] = scenarios,
): Promise<Result[]> => {
  const results: Result[] = [];
  for (const scenario of selected) {
    const lateBefore = client.lateReplies?.length ?? 0;
    const heldBefore = client.heldMs?.length ?? 0;
    try {
      const outcome = await scenario.run(client, env, results);
      const late = client.lateReplies?.slice(lateBefore) ?? [];
      const held = client.heldMs?.slice(heldBefore) ?? [];
      const measurements = {
        ...outcome.measurements,
        ...(held.length === 0 ? {} : { held: heldSummary(held) }),
        ...(late.length === 0
          ? {}
          : {
              lateReplies: late.map(
                ({ opcode, heldMs, afterMs }) =>
                  `opcode ${opcode}: no reply in ${heldMs} ms of holding the thread; ` +
                  `it came ${afterMs} ms after the thread was let go`,
              ),
            }),
      };
      results.push({
        name: scenario.name,
        criterion: scenario.criterion,
        pass: outcome.pass && late.length === 0,
        measurements,
        ...(late.length === 0
          ? {}
          : { passWithoutLateReplies: outcome.pass, lateReplies: late }),
      });
    } catch (error) {
      results.push({
        name: scenario.name,
        criterion: scenario.criterion,
        pass: false,
        measurements: {},
        error: String(error),
      });
      // A request that threw may have left the host unable to answer.
      break;
    }
  }
  return results;
};
