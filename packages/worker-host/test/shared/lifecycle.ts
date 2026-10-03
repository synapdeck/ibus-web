// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// How the host starts, fails to start, reports failures after it has, and
// runs as released: each against hosts of its own.

import { expect } from "vitest";
import type { Harness, RuntimeBuild } from "./harness.ts";
import { call32, int32s, opsFrom, stats } from "./scenarios.ts";
import { HostOp } from "./testing.ts";

// A module that imports a function no runtime provides, so instantiating it
// with the runtime's imports fails with a LinkError: the magic and version,
// a type section with one () -> () type, and an import section with
// env.absent of that type.
const UNLINKABLE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x02, 0x0e, 0x01, 0x03, 0x65,
  0x6e, 0x76, 0x06, 0x61, 0x62, 0x73, 0x65, 0x6e, 0x74, 0x00, 0x00,
]);

// A failed WebAssembly.instantiate() inside Emscripten's instantiateWasm,
// which Emscripten never hears of, fails the host's start.
export const failedInstantiate = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  await expect(h.start({ runtime, wasm: UNLINKABLE })).rejects.toThrow(/^host: .*LinkError/s);
};

// A memory the runtime can't take, one that isn't whole pages and one below
// the least it takes, fails the host's start with the bounds.
export const refusedMemory = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const { minimum } = h.data.constants.memory;
  for (const bytes of [minimum + 1, minimum - 65536])
    await expect(h.start({ runtime, memory: { initial: bytes, maximum: bytes } }), `memory ${bytes}`).rejects.toThrow(
      `host: Error: memory ${bytes}: the runtime takes a whole number of 65536-byte pages`,
    );
};

// The host as released runs the runtime as its test build does, and ignores
// HostInit.test: it starts the relay as released, not the one that fails at
// once, and leaves the test build's requests to the runtime, which knows
// none of them.
export const released = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const host = await h.start({ runtime, released: true, test: { relayFailsAfter: 0 } });
  try {
    const ops = opsFrom(h.data.constants.ops);
    expect(await call32(host.client, ops.add, int32s(2, 3)), "add").toBe(5);
    expect((await host.client.call(HostOp.stats)).ret, "stats").toBe(-h.data.errno["ENOSYS"]!);
  } finally {
    await host.terminate();
  }
};

// A relay that fails while the host sleeps writes CRASHED and wakes the host,
// whose crash report is the relay's error.
export const relayFailure = async (h: Harness, runtime: RuntimeBuild, released = false): Promise<void> => {
  const host = await h.start({ runtime, relayFailsAfter: 3, released });
  try {
    const ops = opsFrom(h.data.constants.ops);
    let answered = 0;
    let failure: unknown;
    for (let i = 0; i < 10 && failure === undefined; i++) {
      try {
        await call32(host.client, ops.add, int32s(i, 1));
        answered++;
      } catch (error) {
        failure = error;
      }
    }
    const report = await host.client.crashReport(2000);
    h.record("relay-failure", { answered, report: report ?? "none" });
    // The relay fails on its fourth wait, but waits don't map to requests:
    // changes that land together are forwarded as one wake, a request the
    // host finds while awake costs the relay nothing, and a wait that
    // returns with nothing new costs it one. Only the failure is certain.
    expect(failure, "a request failed within ten").toBeDefined();
    expect(String(failure), "the request after").toMatch(/crashed/);
    expect(report, "the crash report").toMatch(/^relay: .*the relay fails on purpose/);
  } finally {
    await host.terminate();
  }
};

// A top-up that doesn't finish in time is logged as an error, and the host
// tops up no more but goes on serving.
export const topUpLimit = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const host = await h.start({ runtime, config: { topUpLimitMs: 1 } });
  try {
    const ops = opsFrom(h.data.constants.ops);
    const { client } = host;
    const first = await stats(client);
    const alive = h.data.pool.size + first.workersCreated - first.idleWorkers;
    const overshoot = h.data.pool.planned + 1 - alive;
    expect(replyHeld(await client.call(ops.hold, int32s(overshoot)))).toBe(overshoot);
    const deadline = h.now() + h.pendingLimitMs;
    while (!host.messages.some(({ type }) => type === "log") && h.now() < deadline) {
      await h.sleep(10);
      await stats(client);
    }
    const logs = host.messages.filter(({ type }) => type === "log");
    expect(logs, "the host's log").toEqual([
      { type: "log", level: "Error", message: expect.stringMatching(/1 Workers not all loaded in 1 ms/) },
    ]);
    expect(await call32(client, ops.release), "release").toBeGreaterThanOrEqual(0);
    // Once the Worker that loaded late has joined the pool, the spares are
    // taken again, one more than they number: the host tops up no more.
    await h.sleep(500);
    const before = await stats(client);
    const short = before.idleWorkers - h.data.pool.lowWater + 1;
    expect(replyHeld(await client.call(ops.hold, int32s(short)))).toBe(short);
    await h.sleep(200);
    const last = await stats(client);
    expect(last.idleWorkers, "idle Workers").toBe(h.data.pool.lowWater - 1);
    expect(last.eventLoopTurns - before.eventLoopTurns, "event-loop turns").toBe(0);
    expect(last.topUps, "top-ups finished").toBe(0);
    expect(await call32(client, ops.add, int32s(2, 3)), "add").toBe(5);
    expect(await call32(client, ops.release), "release").toBeGreaterThanOrEqual(0);
  } finally {
    await host.terminate();
  }
};

const replyHeld = ({ ret, bytes }: { ret: number; bytes: Uint8Array }): number =>
  ret < 0 ? ret : new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true);
