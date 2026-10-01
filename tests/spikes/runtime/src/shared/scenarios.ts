// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The runtime spike's scenarios, each with its pass criterion and what it
// measures. They talk to a host only through a Client, so any harness that
// can post requests over the control buffer runs them.

import {
  HostOp,
  type BuildConstants,
  type HostStats,
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

export interface Client {
  call(opcode: number, payload?: Uint8Array): Promise<Reply>;
  // The host's report of why it crashed, or null if none came within
  // timeoutMs.
  crashReport(timeoutMs: number): Promise<string | null>;
  // Calls whose reply came only after the client stopped waiting the way it
  // must, and why; each fails the scenario that made it.
  lateReplies?: readonly string[];
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
  poolSize: number;
  // Files to fsync() from a thread, one per storage backend under test.
  fsyncPaths: readonly string[];
  // How long a result may stay pending before the scenario gives up on it.
  pendingLimitMs: number;
  // Storage that outlives the runtime, mounted at dir, and how the harness
  // reads a file there without the runtime: its contents, or null if there
  // is no such file.
  persistent?: { dir: string; read(name: string): Promise<string | null> };
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
  run(client: Client, env: Env): Promise<Outcome>;
}

export const int32s = (...values: number[]): Uint8Array =>
  new Uint8Array(new Int32Array(values).buffer);

export const replyInt32 = ({ ret, bytes }: Reply): number => {
  if (ret < 0) return ret;
  if (bytes.length !== 4)
    throw new Error(`a reply of ${bytes.length} bytes, not one int32`);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true);
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
// null once env.pendingLimitMs has passed.
const poll = async (
  client: Client,
  env: Env,
  opcode: number,
  intervalMs = 2,
): Promise<{ value: number; ms: number } | null> => {
  const start = env.now();
  for (;;) {
    const value = await call32(client, opcode);
    const ms = env.now() - start;
    if (value !== -env.errno.EAGAIN!) return { value, ms };
    if (ms > env.pendingLimitMs) return null;
    await env.sleep(intervalMs);
  }
};

// Returns the host to its event loop for a moment.
const hostYield = async (client: Client): Promise<void> => {
  const { ret } = await client.call(HostOp.yield);
  if (ret !== 0) throw new Error(`host yield: ${ret}`);
};

const stats = async (client: Client, env: Env): Promise<HostStats> => {
  const { ret, bytes } = await client.call(HostOp.stats);
  if (ret < 0) throw new Error(`host stats: ${ret}`);
  return JSON.parse(env.decode(bytes)) as HostStats;
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
// the host; requestsWhileAsleep says how many of each.
const dispatch: Scenario = {
  name: "dispatch",
  criterion: "1000 add round trips back to back, every sum right",
  async run(client, env) {
    const before = await stats(client, env);
    const { times, wrong } = await addRoundTrips(client, env, 1000, 0);
    const after = await stats(client, env);
    return {
      pass: wrong === 0,
      measurements: {
        wrong,
        ...latencies(times),
        requestsWhileAsleep: `${after.requestsWhileAsleep - before.requestsWhileAsleep} of ${after.requests - before.requests}`,
      },
    };
  },
};

// Every request finds the host asleep, so each round trip pays the whole
// wake path: in "runtime" mode the relay's hop and the host's, in "control"
// mode the host's alone.
const coldWake: Scenario = {
  name: "cold-wake",
  criterion:
    "300 add round trips, each sent 2 ms after the last reply: every sum right, and every request found the host asleep",
  async run(client, env) {
    const gapMs = 2;
    const before = await stats(client, env);
    const { times, wrong } = await addRoundTrips(client, env, 300, gapMs);
    await env.sleep(gapMs);
    const after = await stats(client, env);
    const requests = after.requests - before.requests;
    const asleep = after.requestsWhileAsleep - before.requestsWhileAsleep;
    return {
      pass: wrong === 0 && asleep === requests,
      measurements: {
        wrong,
        ...latencies(times),
        requestsWhileAsleep: `${asleep} of ${requests}`,
      },
    };
  },
};

// The host gets no request while the source is pending, so only GLib's
// wake can get it dispatched.
const crossThreadWake: Scenario = {
  name: "cross-thread-wake",
  criterion:
    "idle-later(50) ×20 with the host idle: attach to dispatch ≤ 20 ms every time",
  async run(client, env): Promise<Outcome> {
    const epsilons: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = await call32(client, env.ops.idleLater, int32s(50));
      if (started !== 0) throw new Error(`idle-later: ${started}`);
      await env.sleep(50 + 150);
      const result = await poll(client, env, env.ops.idleResult);
      if (result === null)
        return {
          pass: false,
          measurements: { epsilonsMs: epsilons, pending: true },
        };
      epsilons.push(result.value / 1000);
    }
    const sorted = [...epsilons].sort((a, b) => a - b);
    const max = sorted.at(-1) ?? Number.NaN;
    return {
      pass: max >= 0 && max <= 20,
      measurements: {
        p50Ms: round(percentile(sorted, 50)),
        maxMs: round(max),
        minMs: round(sorted[0] ?? Number.NaN),
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

const threadCreateBlocked: Scenario = {
  name: "thread-create-blocked",
  criterion:
    "spawn(pool) and spawn(pool + 1) from a pump start and join every thread; " +
    "spawn-nested(idle Workers + 1), whose creations the host runs while it sleeps, " +
    "starts and joins every thread with at least one Worker created beyond the pool",
  async run(client, env) {
    const measurements: Record<string, Measurement> = {
      poolSize: env.poolSize,
    };
    let pass = true;
    const run = async (
      label: string,
      start: number,
      result: number,
      n: number,
    ): Promise<number | null> => {
      const before = await stats(client, env);
      const startedAt = env.now();
      const started = await call32(client, start, int32s(n));
      if (started !== 0) throw new Error(`${label}: ${started}`);
      const joined = await poll(client, env, result);
      const ms = env.now() - startedAt;
      const after = await stats(client, env);
      if (joined === null) {
        measurements[label] = "hung";
        return null;
      }
      measurements[`${label}Joined`] = joined.value;
      measurements[`${label}Ms`] = round(ms, 1);
      const created = after.workersCreated - before.workersCreated;
      measurements[`${label}WorkersCreated`] = created;
      return joined.value === n ? created : null;
    };
    for (const n of [env.poolSize, env.poolSize + 1]) {
      if (
        (await run(`spawn${n}`, env.ops.spawn, env.ops.spawnResult, n)) === null
      )
        pass = false;
    }

    // Each creation from a thread other than the host's waits for the host
    // to run it, which it does inside its sleep; the thread doing the
    // creating holds one idle Worker itself.
    const { idleWorkers } = await stats(client, env);
    measurements.nestedIdleWorkers = idleWorkers;
    const created = await run(
      "nested",
      env.ops.spawnNested,
      env.ops.spawnNestedResult,
      idleWorkers + 1,
    );
    if (created === null || created === 0) pass = false;
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
    "5 rounds of spawn-detached(pool) with the host never returning to its event loop: " +
    "heap in use after each round within 0.5 MiB of the first round's, no Worker created " +
    "in a round that began with enough idle Workers, and nothing left for the event loop to reclaim",
  async run(client, env): Promise<Outcome> {
    const n = env.poolSize;
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
    await check("taskUs", env.ops.task, undefined, env.ops.taskResult);
    return { pass, measurements };
  },
};

const promiseProxiedFsync: Scenario = {
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
const replyFile = (
  { ret, bytes }: Reply,
  env: Env,
): { status: number; text?: string } => {
  if (ret < 0) return { status: ret };
  const status = replyInt32({ ret: 4, bytes: bytes.subarray(0, 4) });
  return status < 0
    ? { status }
    : { status, text: env.decode(bytes.subarray(4)) };
};

// Runs after promise-proxied-fsync, whose file on the mount it reads back.
export const opfs: Scenario = {
  name: "opfs",
  criterion:
    "on WasmFS's OPFS backend: a file absent at first (the storage is fresh) is written and " +
    "fsync()ed on the host's thread, and reads back the same through the runtime and through " +
    "the page's OPFS API; promise-proxied-fsync's file reads back through the OPFS API too",
  async run(client, env) {
    const { persistent } = env;
    if (persistent === undefined)
      throw new Error("the harness mounts no persistent storage");
    const name = "opfs-check.txt";
    const path = `${persistent.dir}/${name}`;
    const contents = `written to ${path} by the runtime`;
    const read = async () =>
      replyFile(await client.call(env.ops.readFile, env.utf8(path)), env);

    // The backend's own thread holds one of them for good.
    const { idleWorkers } = await stats(client, env);
    const before = await read();
    const startedAt = env.now();
    const written = await call32(
      client,
      env.ops.writeFile,
      env.utf8(`${path}\0${contents}`),
    );
    const writeMs = env.now() - startedAt;
    const readAt = env.now();
    const after = await read();
    const readMs = env.now() - readAt;
    const outside = await persistent.read(name);

    const fsyncPath = env.fsyncPaths.find((file) =>
      file.startsWith(`${persistent.dir}/`),
    );
    const fsyncFile =
      fsyncPath === undefined
        ? undefined
        : await persistent.read(fsyncPath.slice(persistent.dir.length + 1));
    const fsyncMatches = fsyncPath !== undefined && fsyncFile === fsyncPath;

    const bytes = env.utf8(contents).length;
    return {
      pass:
        before.status === -env.errno.ENOENT! &&
        written === bytes &&
        after.text === contents &&
        outside === contents &&
        fsyncMatches,
      measurements: {
        idleWorkers: `${idleWorkers} of a pool of ${env.poolSize}`,
        before: before.status,
        written,
        writeAndFsyncMs: round(writeMs, 2),
        readBack:
          after.text === contents ? "same" : (after.text ?? after.status),
        readMs: round(readMs, 2),
        throughOpfsApi: outside === contents ? "same" : (outside ?? "absent"),
        fsyncFileThroughOpfsApi: fsyncMatches
          ? "same"
          : (fsyncFile ?? "absent"),
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

// thread-create-blocked runs before any other scenario starts a thread, so
// the pool holds only the Workers it started with.
export const scenarios: readonly Scenario[] = [
  dispatch,
  coldWake,
  threadCreateBlocked,
  threadExitBlocked,
  crossThreadWake,
  deadline,
  syncProxied,
  promiseProxiedFsync,
  exceptions,
];

export interface Result extends Outcome {
  name: string;
  criterion: string;
  error?: string;
}

export const runScenarios = async (
  client: Client,
  env: Env,
  selected: readonly Scenario[] = scenarios,
): Promise<Result[]> => {
  const results: Result[] = [];
  for (const scenario of selected) {
    const lateBefore = client.lateReplies?.length ?? 0;
    try {
      const outcome = await scenario.run(client, env);
      const late = client.lateReplies?.slice(lateBefore) ?? [];
      results.push({
        name: scenario.name,
        criterion: scenario.criterion,
        ...outcome,
        ...(late.length === 0
          ? {}
          : {
              pass: false,
              measurements: { ...outcome.measurements, lateReplies: late },
            }),
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
