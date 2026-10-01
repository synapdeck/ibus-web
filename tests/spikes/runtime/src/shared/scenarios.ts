// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The runtime spike's scenarios, each with its pass criterion and what it
// measures. They talk to a host only through a Client, so any harness that
// can post requests over the control buffer runs them.

import { HostOp, type HostStats, type Reply } from "./control.ts";

// The opcodes the spike side modules register.
export const Op = {
  add: 1,
  idleLater: 2,
  idleResult: 3,
  spawn: 4,
  spawnResult: 5,
  throw: 6,
  fsync: 7,
  fsyncResult: 8,
  spawnDetached: 9,
  spawnDetachedResult: 10,
  spawnNested: 11,
  spawnNestedResult: 12,
  proxySync: 13,
  proxySyncResult: 14,
  task: 15,
  taskResult: 16,
  timeout: 17,
  timeoutResult: 18,
} as const;

export interface Client {
  call(opcode: number, payload?: Uint8Array): Promise<Reply>;
}

export interface Env {
  // Milliseconds, from a monotonic clock.
  now(): number;
  sleep(ms: number): Promise<void>;
  utf8(text: string): Uint8Array;
  decode(bytes: Uint8Array): string;
  // Emscripten's errno values, by name.
  errno: Readonly<Record<string, number>>;
  poolSize: number;
  // Files to fsync() from a thread, one per storage backend under test.
  fsyncPaths: readonly string[];
  // How long a result may stay pending before the scenario gives up on it.
  pendingLimitMs: number;
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

const dispatch: Scenario = {
  name: "dispatch",
  criterion: "1000 add round trips, every sum right",
  async run(client, env) {
    const rounds = 1000;
    const times: number[] = [];
    let wrong = 0;
    for (let i = 0; i < rounds; i++) {
      const start = env.now();
      const sum = await call32(client, Op.add, int32s(i, 1000));
      times.push(env.now() - start);
      if (sum !== i + 1000) wrong++;
    }
    times.sort((a, b) => a - b);
    return {
      pass: wrong === 0,
      measurements: {
        wrong,
        p50Us: round(percentile(times, 50) * 1000, 1),
        p99Us: round(percentile(times, 99) * 1000, 1),
        maxUs: round((times.at(-1) ?? Number.NaN) * 1000, 1),
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
      const started = await call32(client, Op.idleLater, int32s(50));
      if (started !== 0) throw new Error(`idle-later: ${started}`);
      await env.sleep(50 + 150);
      const result = await poll(client, env, Op.idleResult);
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
      const started = await call32(client, Op.timeout, int32s(100));
      if (started !== 0) throw new Error(`timeout: ${started}`);
      await env.sleep(300);
      const result = await poll(client, env, Op.timeoutResult);
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
    "spawn(pool) and spawn(pool + 1) from a pump start and join every thread without hanging; " +
    "records the Workers created beyond the pool, and what detached threads leave behind",
  async run(client, env) {
    const measurements: Record<string, Measurement> = {
      poolSize: env.poolSize,
    };
    let pass = true;
    for (const n of [env.poolSize, env.poolSize + 1]) {
      const before = await stats(client, env);
      const start = env.now();
      const started = await call32(client, Op.spawn, int32s(n));
      if (started !== 0) throw new Error(`spawn(${n}): ${started}`);
      const result = await poll(client, env, Op.spawnResult);
      const ms = env.now() - start;
      const after = await stats(client, env);
      if (result === null) {
        pass = false;
        measurements[`spawn${n}`] = "hung";
        continue;
      }
      if (result.value !== n) pass = false;
      measurements[`spawn${n}Joined`] = result.value;
      measurements[`spawn${n}Ms`] = round(ms, 1);
      measurements[`spawn${n}WorkersCreated`] =
        after.workersCreated - before.workersCreated;
    }

    // A detached thread ends without a join on the host's thread, so
    // Emscripten frees its stack and hands its Worker back only through a
    // message to that thread's event loop. Rounds of detached threads, first
    // with the host never returning to its event loop, then with it
    // returning before each round.
    const rounds = async (
      label: string,
      count: number,
      yieldFirst: boolean,
    ): Promise<boolean> => {
      const created: number[] = [];
      const heapMiB: number[] = [];
      for (let i = 0; i < count; i++) {
        if (yieldFirst) await hostYield(client);
        const before = await stats(client, env);
        const n = await call32(client, Op.spawnDetached, int32s(env.poolSize));
        if (n !== env.poolSize) throw new Error(`spawn-detached: ${n}`);
        const result = await poll(client, env, Op.spawnDetachedResult);
        if (result === null) {
          measurements[label] = "hung";
          return false;
        }
        // Let the threads finish exiting.
        await env.sleep(50);
        const after = await stats(client, env);
        created.push(after.workersCreated - before.workersCreated);
        heapMiB.push(round(after.heapInUse / 2 ** 20, 2));
      }
      measurements[`${label}WorkersCreated`] = created;
      measurements[`${label}HeapInUseMiB`] = heapMiB;
      return true;
    };
    pass = (await rounds("blocked", 5, false)) && pass;
    await hostYield(client);
    measurements.afterOneYieldHeapInUseMiB = round(
      (await stats(client, env)).heapInUse / 2 ** 20,
      2,
    );
    pass = (await rounds("yielding", 3, true)) && pass;
    measurements.workersCreatedTotal = (
      await stats(client, env)
    ).workersCreated;
    return { pass, measurements };
  },
};

const syncProxied: Scenario = {
  name: "sync-proxied",
  criterion:
    "while the host sleeps: a call proxied synchronously to its thread, a thread creating threads, " +
    "and a GTask in GLib's thread pool all complete",
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
    await check("proxySyncUs", Op.proxySync, undefined, Op.proxySyncResult);
    await check(
      "spawnNestedJoined",
      Op.spawnNested,
      int32s(2),
      Op.spawnNestedResult,
      2,
    );
    await check("taskUs", Op.task, undefined, Op.taskResult);
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
      const started = await call32(client, Op.fsync, bytes);
      if (started !== 0) throw new Error(`fsync(${path}): ${started}`);
      const result = await poll(client, env, Op.fsyncResult);
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
    const thrown = await call32(client, Op.throw);
    const after = await call32(client, Op.add, int32s(1, 1));
    return {
      pass: thrown === -env.errno.ECANCELED! && after === 2,
      measurements: { throwReply: thrown, addAfter: after },
    };
  },
};

// thread-create-blocked runs before any other scenario starts a thread, so
// the pool holds only the Workers it started with.
export const scenarios: readonly Scenario[] = [
  dispatch,
  threadCreateBlocked,
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

// Between scenarios the host gets a turn of its event loop, which hands
// back the stacks and Workers of threads that ended without a join on its
// thread (thread-create-blocked measures what happens without), so each
// scenario starts from the same memory.
export const runScenarios = async (
  client: Client,
  env: Env,
  selected: readonly Scenario[] = scenarios,
): Promise<Result[]> => {
  const results: Result[] = [];
  for (const scenario of selected) {
    try {
      await hostYield(client);
      results.push({
        name: scenario.name,
        criterion: scenario.criterion,
        ...(await scenario.run(client, env)),
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
