// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { encodeRequest, Init, CreateEngine, PROTOCOL_VERSION, ReqMode, Word, State } from "@ibus-web/protocol";
import { expect } from "vitest";
import { createControl, controlViews, postCrash, postReply, postRequest } from "../../src/shared/control.ts";
import type { Harness, RunningHost } from "./harness.ts";
import { HostOp } from "./testing.ts";
import { int32s } from "./scenarios.ts";

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
