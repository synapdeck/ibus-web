// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { encodeRequest, Init, CreateEngine, PROTOCOL_VERSION, ReqMode, Word, State } from "@ibus-web/protocol";
import { expect } from "vitest";
import {
  createControl,
  controlViews,
  postCrash,
  postReply,
  postRequest,
  takeReply,
  type ControlViews,
} from "../../src/shared/control.ts";
import type { Harness, RunningHost } from "./harness.ts";
import { HostOp } from "./testing.ts";
import { int32s } from "./scenarios.ts";
import { Page } from "./page.ts";

export const protocolRoundtrip = async (h: Harness, { client }: RunningHost): Promise<void> => {
  const page = client.page;
  page.post(encodeRequest(0, new Init({ version: PROTOCOL_VERSION, settings: {} })), ReqMode.sync);
  expect((await page.waitForReply()).ret).toBe(0);
  page.post(encodeRequest(0, new Init({ version: PROTOCOL_VERSION, settings: {} })), ReqMode.sync);
  expect((await page.waitForReply()).ret).toBe(-h.data.errno["EALREADY"]!);
  page.post(encodeRequest(1, new CreateEngine({ name: "absent" })), ReqMode.sync);
  expect((await page.waitForReply()).ret).toBe(-h.data.errno["ESRCH"]!);
};

export const replySequence = async (h: Harness, { client }: RunningHost): Promise<void> => {
  const page = client.page;
  page.post(
    encodeRequest(
      0,
      new Init({
        version: PROTOCOL_VERSION,
        settings: {
          "org.example.absent": { unknown: { _tag: "v", type: "s", value: { _tag: "s", value: "ignored" } } },
        },
      }),
    ),
    ReqMode.sync,
  );
  const first = await page.waitForReply();
  expect(first.ret).toBe(0);
  const records = page.records();
  expect(records.length).toBeGreaterThan(0);
  expect(records.every(({ record }) => record._tag === "Log")).toBe(true);
  expect(first.outSeq).toBe(records.at(-1)!.seq);
  page.post(encodeRequest(1, new CreateEngine({ name: "absent" })), ReqMode.sync);
  const second = await page.waitForReply();
  expect(second.ret).toBe(-h.data.errno["ESRCH"]!);
  expect(second.outSeq).toBe(first.outSeq);
  expect(page.records()).toEqual([]);
};

export const requestModes = async (h: Harness, { client, messages }: RunningHost): Promise<void> => {
  const page = client.page;
  const bells = () => messages.filter(({ type }) => type === "doorbell").length;
  page.request(HostOp.yield, 0, int32s(10), ReqMode.async);
  await page.waitForReply();
  await h.sleep(30);
  expect(bells()).toBe(1);
  page.request(HostOp.yield, 0, int32s(10), ReqMode.sync);
  await page.waitForReply();
  await h.sleep(30);
  expect(bells()).toBe(1);
  page.request(HostOp.yield, 0, int32s(100), ReqMode.sync);
  expect(page.abandon()).toBeUndefined();
  await page.waitForReply();
  await h.sleep(30);
  expect(bells()).toBe(2);
  page.request(HostOp.yield, 0, int32s(10), ReqMode.sync);
  const deadline = h.now() + h.pendingLimitMs;
  while (Atomics.load(page.views.words, Word.state) !== State.reply && h.now() < deadline) await h.sleep(1);
  expect(Atomics.load(page.views.words, Word.state)).toBe(State.reply);
  // The host has completed its reqMode read before the page gives up spinning.
  await h.sleep(30);
  expect(page.abandon()?.ret).toBe(0);
  await h.sleep(30);
  expect(bells()).toBe(2);
};

export const timerOutput = async (h: Harness, { client, messages }: RunningHost): Promise<void> => {
  const page = client.page;
  page.post(encodeRequest(0, new Init({ version: PROTOCOL_VERSION, settings: {} })), ReqMode.sync);
  expect((await page.waitForReply()).ret).toBe(0);
  expect((await client.call(h.data.constants.ops["TIMER_OUTPUT"]!)).ret).toBe(0);
  // Hold the page's event loop through two distinct timer pumps. Neither
  // doorbell handler can drain or clear the outstanding bell meanwhile.
  const deadline = h.now() + h.pendingLimitMs;
  let first = 0;
  while (h.now() < deadline) {
    const written = Atomics.load(page.views.words, Word.ringWrite);
    if (written > 0 && first === 0) {
      const payloadBytes = new DataView(page.views.ring.buffer, page.views.ring.byteOffset).getUint32(12, true);
      first = Math.ceil((16 + payloadBytes) / 8) * 8;
    }
    if (written > first && first !== 0) break;
  }
  expect(first).toBeGreaterThan(0);
  expect(Atomics.load(page.views.words, Word.ringWrite)).toBeGreaterThan(first);
  expect(Atomics.load(page.views.words, Word.doorbell)).toBe(1);
  await h.sleep(30);
  expect(messages.filter(({ type }) => type === "doorbell")).toHaveLength(1);
  const records = page.records();
  expect(records.map(({ record }) => record._tag)).toEqual(["Log", "Log"]);
  expect(records.map(({ seq }) => seq)).toEqual([1, 2]);
  expect(Atomics.load(page.views.words, Word.doorbell)).toBe(0);
};

export const crashWinsReply = (): void => {
  for (const crashFirst of [true, false]) {
    const views = controlViews(createControl());
    postRequest(views, encodeRequest(0, new Init({ version: PROTOCOL_VERSION, settings: {} })), ReqMode.sync);
    if (crashFirst) postCrash(views);
    expect(postReply(views, 0, 0)).toBe(!crashFirst);
    if (!crashFirst) postCrash(views);
    expect(Atomics.load(views.words, Word.state)).toBe(State.crashed);
  }
};

// Inject the relay's crash just after the helper has observed the expected
// state. The helper continues with that observation while the shared state
// already contains CRASHED, matching a concurrent relay write.
const crashAfterStateRead = (views: ControlViews, use: () => void): void => {
  const load = Atomics.load;
  let injected = false;
  Atomics.load = ((words: Int32Array, index: number): number => {
    const value = load(words, index);
    if (!injected && words === views.words && index === Word.state) {
      injected = true;
      postCrash(views);
    }
    return value;
  }) as typeof Atomics.load;
  try {
    use();
    expect(injected).toBe(true);
  } finally {
    Atomics.load = load;
  }
};

export const crashWinsRequestPublication = (): void => {
  const views = controlViews(createControl());
  const request = encodeRequest(0, new Init({ version: PROTOCOL_VERSION, settings: {} }));
  crashAfterStateRead(views, () => {
    expect(() => postRequest(views, request, ReqMode.async)).toThrow("crashed");
  });
  expect(Atomics.load(views.words, Word.state)).toBe(State.crashed);
  expect(Atomics.load(views.words, Word.wake)).toBe(0);
};

export const crashWinsTakingReply = (): void => {
  const views = controlViews(createControl());
  postRequest(views, encodeRequest(0, new Init({ version: PROTOCOL_VERSION, settings: {} })), ReqMode.sync);
  expect(postReply(views, -42, 0xfedcba98)).toBe(true);
  crashAfterStateRead(views, () => {
    expect(() => takeReply(views)).toThrow("crashed");
  });
  expect(Atomics.load(views.words, Word.state)).toBe(State.crashed);
  expect(Atomics.load(views.words, Word.replyRet)).toBe(-42);
  expect(Atomics.load(views.words, Word.replyOutSeq) >>> 0).toBe(0xfedcba98);
};

export const crashRejectsAsyncReply = async (): Promise<void> => {
  let deadlineCanceled = 0;
  let rejected = 0;
  const page = new Page(
    createControl(),
    {
      now: () => 0,
      sleep: () => Promise.resolve(),
      schedule: () => () => {
        deadlineCanceled++;
      },
    },
    1000,
  );
  page.post(encodeRequest(0, new Init({ version: PROTOCOL_VERSION, settings: {} })), ReqMode.async);
  const result = page.waitForReply().catch((error: unknown) => {
    rejected++;
    return error;
  });
  expect(postReply(page.views, 0, 123)).toBe(true);
  crashAfterStateRead(page.views, () => {
    expect(() => page.onDoorbell()).not.toThrow();
  });
  expect(await result).toEqual(expect.objectContaining({ message: "the host has crashed" }));
  expect(Atomics.load(page.views.words, Word.state)).toBe(State.crashed);
  expect(deadlineCanceled).toBe(1);
  expect(rejected).toBe(1);
  // Later notifications cannot settle or cancel the completed waiter again.
  page.onDoorbell();
  page.onCrash();
  expect(deadlineCanceled).toBe(1);
  expect(rejected).toBe(1);
};
