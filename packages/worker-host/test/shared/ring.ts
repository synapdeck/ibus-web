// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  CreateEngine,
  Init,
  ProcessKeyEvent,
  PROTOCOL_VERSION,
  ReqMode,
  State,
  Word,
  encodeRequest,
  transportLayout,
  type DecodedRecord,
} from "@ibus-web/protocol";
import { expect } from "vitest";
import type { Harness, RunningHost, RuntimeBuild } from "./harness.ts";
import { postCrash } from "../../src/shared/control.ts";
import { PumpControl, RuntimeCall } from "./testing.ts";

const largeBytes = 64 * 1024;
// Larger than all the output buffered before it, so appending it reallocates
// the runtime's output buffer.
const appendBytes = 256 * 1024;
const key = (value: string, bytes = 0) =>
  new ProcessKeyEvent({ keyval: value.charCodeAt(0), keycode: 0, state: bytes });
const postKey = (host: RunningHost, value: string, bytes = 0): void =>
  host.client.page.post(encodeRequest(1, key(value, bytes)), ReqMode.sync);
const until = async (h: Harness, check: () => boolean): Promise<void> => {
  const deadline = h.now() + h.pendingLimitMs;
  while (!check() && h.now() < deadline) await h.sleep(1);
  expect(check(), "condition before deadline").toBe(true);
};
const commits = (records: DecodedRecord[]) => records.filter(({ record }) => record._tag === "CommitText");
const start = async (h: Harness, runtime: RuntimeBuild) => {
  const runtimeCalls = new SharedArrayBuffer(16);
  const waitTrap = new SharedArrayBuffer(4);
  const deferPump = new SharedArrayBuffer(4);
  const waitAppend = new SharedArrayBuffer(4);
  const host = await h.start({
    runtime,
    manifest: h.data.engines.echo,
    layout: transportLayout({ ringBytes: 4096 }),
    test: {
      sides: [],
      runtimeCalls,
      waitTrap,
      deferPump,
      waitTrapOp: h.data.constants.ops["WAIT_TRAP"]!,
      waitAppend,
      waitAppendOp: h.data.constants.ops["LOG"]!,
      waitAppendBytes: appendBytes,
    },
  });
  const page = host.client.page;
  page.post(encodeRequest(0, new Init({ version: PROTOCOL_VERSION, settings: {} })), ReqMode.sync);
  expect((await page.waitForReply()).ret).toBe(0);
  page.post(encodeRequest(1, new CreateEngine({ name: "echo" })), ReqMode.sync);
  expect((await page.waitForReply()).ret).toBe(0);
  page.records();
  return {
    host,
    page,
    counts: new Int32Array(runtimeCalls),
    trap: new Int32Array(waitTrap),
    defer: new Int32Array(deferPump),
    append: new Int32Array(waitAppend),
  };
};

export const largeCommit = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const { host, page } = await start(h, runtime);
  try {
    const previousSeq = Atomics.load(page.views.words, Word.replyOutSeq) >>> 0;
    postKey(host, "b", largeBytes);
    const reply = await page.waitForReply();
    const records = commits(page.records());
    expect(reply.ret).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.record).toMatchObject({ _tag: "CommitText", text: { text: "b".repeat(largeBytes) } });
    expect(reply.outSeq).toBe(records[0]?.seq);
    expect(reply.outSeq).toBe(previousSeq + 1);
    expect(Atomics.load(page.views.words, Word.ringWrite) - Atomics.load(page.views.words, Word.ringRead)).toBe(0);
  } finally {
    await host.terminate();
  }
};

export const fullRingReply = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const { host, page, counts } = await start(h, runtime);
  try {
    page.pauseReading();
    const consumed = Atomics.load(counts, RuntimeCall.consumed);
    postKey(host, "b", largeBytes);
    await until(h, () => Atomics.load(page.views.words, Word.ringWaiting) === 1);
    await until(h, () => host.messages.some(({ type }) => type === "doorbell"));
    const pumps = Atomics.load(counts, RuntimeCall.pump);
    const waits = Atomics.load(counts, RuntimeCall.wait);
    expect(Atomics.load(page.views.words, Word.state)).toBe(State.request);
    expect(Atomics.load(counts, RuntimeCall.consumed)).toBe(consumed);
    await h.sleep(50);
    expect(Atomics.load(counts, RuntimeCall.pump)).toBe(pumps);
    expect(Atomics.load(counts, RuntimeCall.wait)).toBe(waits);
    expect(host.messages.filter(({ type }) => type === "doorbell")).toHaveLength(1);
    page.resumeReading();
    const reply = await page.waitForReply();
    const records = commits(page.records());
    expect(records).toHaveLength(1);
    expect(reply.outSeq).toBe(records[0]?.seq);
    expect(records[0]?.record).toMatchObject({ text: { text: "b".repeat(largeBytes) } });
  } finally {
    await host.terminate();
  }
};

// A record appended on the host's thread while it waits for ring space, as a
// call another thread proxied to it can, belongs to no request: the reply
// names only what the request's drain published, and the record follows.
export const fullRingAppend = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const { host, page, append } = await start(h, runtime);
  try {
    page.pauseReading();
    Atomics.store(append, 0, 1);
    postKey(host, "b", largeBytes);
    await until(h, () => Atomics.load(append, 0) === 0);
    page.resumeReading();
    const reply = await page.waitForReply();
    expect(reply.ret).toBe(1);
    const records = page.records();
    const committed = commits(records);
    expect(committed).toHaveLength(1);
    expect(committed[0]?.record).toMatchObject({ text: { text: "b".repeat(largeBytes) } });
    expect(reply.outSeq).toBe(committed[0]?.seq);
    const isAppended = ({ record }: DecodedRecord) => record._tag === "Log" && record.message.startsWith("l");
    const later = records.filter(isAppended);
    await until(h, () => {
      later.push(...page.records().filter(isAppended));
      return later.length > 0;
    });
    expect(later).toHaveLength(1);
    expect(later[0]?.seq).toBe(reply.outSeq + 1);
    expect(later[0]?.record).toMatchObject({ message: "l".repeat(appendBytes) });
  } finally {
    await host.terminate();
  }
};

export const idleFullRing = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const { host, page, counts, defer } = await start(h, runtime);
  try {
    page.pauseReading();
    Atomics.store(defer, 0, PumpControl.deferOnce);
    postKey(host, "c", largeBytes);
    const scheduled = await page.waitForReply();
    expect(scheduled.ret).toBe(1);
    await until(h, () => Atomics.load(page.views.words, Word.ringWaiting) === 1);
    const pumps = Atomics.load(counts, RuntimeCall.pump);
    const dispatched = Atomics.load(counts, RuntimeCall.dispatch);
    postKey(host, "b", 32);
    await h.sleep(50);
    expect(Atomics.load(page.views.words, Word.state)).toBe(State.request);
    expect(Atomics.load(counts, RuntimeCall.dispatch)).toBe(dispatched);
    expect(Atomics.load(counts, RuntimeCall.pump)).toBe(pumps);
    page.resumeReading();
    const reply = await page.waitForReply();
    const records = commits(page.records());
    expect(records.map(({ record }) => (record._tag === "CommitText" ? record.text.text : ""))).toEqual([
      "c".repeat(largeBytes),
      "b".repeat(32),
    ]);
    expect(records[1]!.seq).toBe(records[0]!.seq + 1);
    expect(reply.outSeq).toBe(records[1]!.seq);
  } finally {
    await host.terminate();
  }
};

export const idleRequestOrder = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const { host, page, defer } = await start(h, runtime);
  try {
    const spinForReply = () => {
      const deadline = h.now() + h.pendingLimitMs;
      while (Atomics.load(page.views.words, Word.state) === State.request && h.now() < deadline) {
        // Doorbell handlers cannot run while the page holds this thread.
      }
      expect(Atomics.load(page.views.words, Word.state)).toBe(State.reply);
      return page.takeReply();
    };
    const previousSeq = Atomics.load(page.views.words, Word.replyOutSeq) >>> 0;
    Atomics.store(defer, 0, PumpControl.armHold);
    postKey(host, "c");
    const first = spinForReply();
    postKey(host, "b", 32);
    const second = spinForReply();
    const records = commits(page.records());
    expect(records.map(({ record }) => (record._tag === "CommitText" ? record.text.text : ""))).toEqual([
      "b".repeat(32),
      "idle",
    ]);
    expect(records[1]!.seq).toBe(records[0]!.seq + 1);
    expect(first.outSeq).toBe(previousSeq);
    expect(records[0]!.seq).toBe(previousSeq + 1);
    expect(second.outSeq).toBe(records[1]!.seq);
  } finally {
    await host.terminate();
  }
};

export const fullRingTrap = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const { host, page, counts, trap, defer } = await start(h, runtime);
  try {
    page.pauseReading();
    Atomics.store(defer, 0, PumpControl.deferOnce);
    postKey(host, "c", largeBytes);
    expect((await page.waitForReply()).ret).toBe(1);
    await until(h, () => Atomics.load(page.views.words, Word.ringWaiting) === 1);
    const pumps = Atomics.load(counts, RuntimeCall.pump);
    Atomics.store(trap, 0, 1);
    postKey(host, "a");
    await until(h, () => Atomics.load(page.views.words, Word.state) === State.crashed);
    expect(await host.client.crashReport(h.pendingLimitMs)).toMatch(/RuntimeError:.*unreachable/i);
    expect(Atomics.load(counts, RuntimeCall.pump)).toBe(pumps);
    expect(page.records().some(({ record }) => record._tag === "Crashed")).toBe(false);
    await expect(page.waitForReply()).rejects.toThrow("crashed");
  } finally {
    await host.terminate();
  }
};

export const fullRingRelayCrash = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const { host, page, counts, defer } = await start(h, runtime);
  try {
    page.pauseReading();
    Atomics.store(defer, 0, PumpControl.deferOnce);
    postKey(host, "c", largeBytes);
    expect((await page.waitForReply()).ret).toBe(1);
    await until(h, () => Atomics.load(page.views.words, Word.ringWaiting) === 1);
    const before = Array.from(counts);
    // A failed relay publishes this state and wakes the runtime before its
    // Worker error can reach the host's blocked event loop.
    postCrash(page.views);
    Atomics.add(page.views.words, Word.wake, 1);
    Atomics.notify(page.views.words, Word.wake);
    expect(await host.client.crashReport(h.pendingLimitMs)).toContain("relay failed during output drain");
    expect(Atomics.load(page.views.words, Word.state)).toBe(State.crashed);
    expect(Atomics.load(counts, RuntimeCall.dispatch)).toBe(before[RuntimeCall.dispatch]);
    expect(Atomics.load(counts, RuntimeCall.pump)).toBe(before[RuntimeCall.pump]);
    expect(Atomics.load(counts, RuntimeCall.consumed)).toBe(before[RuntimeCall.consumed]);
    const waits = Atomics.load(counts, RuntimeCall.wait);
    await h.sleep(50);
    expect(Atomics.load(counts, RuntimeCall.wait)).toBe(waits);
  } finally {
    await host.terminate();
  }
};
