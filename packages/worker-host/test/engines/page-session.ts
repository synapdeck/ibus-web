// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  CreateEngine,
  FocusIn,
  IBusCapability,
  Init,
  ProcessKeyEvent,
  PROTOCOL_VERSION,
  ReqMode,
  SetCapabilities,
  encodeRequest,
  stringVariant,
  type DecodedRecord,
  type EngineManifest,
  type Request,
} from "@ibus-web/protocol";
import { expect } from "vitest";
import type { Harness, RuntimeBuild, RunningHost } from "../shared/harness.ts";
import { HostOp, type HostStats } from "../shared/testing.ts";

export const HANGUL_SCHEMA = "org.freedesktop.ibus.engine.hangul";
export const CAPABILITIES =
  IBusCapability.PREEDIT_TEXT |
  IBusCapability.AUXILIARY_TEXT |
  IBusCapability.LOOKUP_TABLE |
  IBusCapability.FOCUS |
  IBusCapability.SURROUNDING_TEXT;
export const Key = {
  hangul: [0xff31, 122],
  f8: [0xffc5, 66],
  f9: [0xffc6, 67],
  pageDown: [0xff56, 109],
  space: [32, 57],
} as const;

export interface HangulBuild {
  manifest: EngineManifest;
  heapBytes: number;
  poolBase: number;
}
declare module "vitest" {
  interface ProvidedContext {
    hangul: HangulBuild;
  }
}

// Every exchange checks the output barrier, including requests that emit nothing.
export class PageSession {
  private lastSeq = 0;
  readonly host: RunningHost;
  private constructor(host: RunningHost) {
    this.host = host;
  }

  static async start(h: Harness, runtime: RuntimeBuild, manifest: EngineManifest): Promise<PageSession> {
    const engine = { ...manifest, name: `${manifest.name}-${runtime.name}-${crypto.randomUUID()}` };
    const host = await h.start({
      runtime,
      manifest: engine,
      storage: h.storage(engine),
      test: { sides: h.sides.filter((side) => side.name === "settings") },
    });
    const session = new PageSession(host);
    try {
      await session.request(
        0,
        new Init({
          version: PROTOCOL_VERSION,
          settings: {
            [HANGUL_SCHEMA]: { "hanja-keys": stringVariant("Hangul_Hanja,F9,F8") },
          },
        }),
      );
      await session.create(1);
      return session;
    } catch (error) {
      await host.terminate();
      throw error;
    }
  }

  private checkRecords(outSeq: number): DecodedRecord[] {
    const records = this.host.client.page.records();
    for (const { seq, record } of records) {
      if (seq !== 0) {
        expect(seq).toBe((this.lastSeq + 1) >>> 0 || 1);
        this.lastSeq = seq;
      }
      if (record._tag === "Log") expect(record.level & (4 | 8 | 16), record.message).toBe(0);
    }
    expect(outSeq).toBe(this.lastSeq);
    return records;
  }

  async request(ic: number, request: Request, ret = 0): Promise<DecodedRecord[]> {
    this.host.client.page.post(encodeRequest(ic, request), ReqMode.sync);
    const reply = await this.host.client.page.waitForReply();
    expect(reply.ret, request._tag).toBe(ret);
    return this.checkRecords(reply.outSeq);
  }

  async key(ic: number, keyval: number, keycode: number, ret = 1): Promise<DecodedRecord[]> {
    const press = await this.request(ic, new ProcessKeyEvent({ keyval, keycode, state: 0 }), ret);
    const release = await this.request(ic, new ProcessKeyEvent({ keyval, keycode, state: 1 << 30 }), 0);
    return [...press, ...release];
  }

  async create(ic: number): Promise<void> {
    await this.request(ic, new CreateEngine({ name: "hangul" }));
    await this.request(ic, new SetCapabilities({ capabilities: CAPABILITIES }));
    await this.request(ic, new FocusIn({}));
    await this.key(ic, ...Key.hangul);
  }

  async writeStringSetting(kind: number, schema: string, key: string, value: string): Promise<DecodedRecord[]> {
    const payload = new TextEncoder().encode([schema, key, value, ""].join("\0"));
    const reply = await this.host.client.call(kind, payload);
    expect(reply.ret).toBe(4);
    expect(new DataView(reply.bytes.buffer, reply.bytes.byteOffset).getInt32(0, true)).toBe(1);
    return this.checkRecords(reply.outSeq);
  }

  async stats(): Promise<HostStats> {
    const reply = await this.host.client.call(HostOp.stats);
    this.checkRecords(reply.outSeq);
    return JSON.parse(new TextDecoder().decode(reply.bytes)) as HostStats;
  }
}
