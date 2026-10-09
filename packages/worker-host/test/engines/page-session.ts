// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  CreateEngine,
  Enable,
  FocusIn,
  IBusCapability,
  Init,
  ProcessKeyEvent,
  PROTOCOL_VERSION,
  ReqMode,
  SetCapabilities,
  encodeRequest,
  type DecodedRecord,
  type ModuleManifest,
  type Request,
} from "@ibus-web/protocol";
import { expect } from "vitest";
import type { Harness, RuntimeBuild, RunningHost } from "../shared/harness.ts";
import { HostOp, type HostStats } from "../shared/testing.ts";

export const CAPABILITIES =
  IBusCapability.PREEDIT_TEXT |
  IBusCapability.AUXILIARY_TEXT |
  IBusCapability.LOOKUP_TABLE |
  IBusCapability.FOCUS |
  IBusCapability.SURROUNDING_TEXT;
export const Key = {
  hangul: [0xff31, 122],
  escape: [0xff1b, 1],
  f8: [0xffc5, 66],
  f9: [0xffc6, 67],
  pageDown: [0xff56, 109],
  space: [32, 57],
} as const;

// What a module's suite runs against: its distributions' manifests by name,
// with URLs as this environment fetches them, the program break and pool
// it is held to, and texts its build computed.
export interface ModuleBuild {
  manifests: Readonly<Record<string, ModuleManifest>>;
  heapBytes: number;
  poolBase: number;
  texts: Readonly<Record<string, string>>;
}
declare module "vitest" {
  interface ProvidedContext {
    module: ModuleBuild;
  }
}

export interface SessionOptions {
  settings: Init["settings"];
  // The engine create() makes unless told another.
  engine: string;
  // Runs once a context's engine is created and focused.
  ready?: (session: PageSession, ic: number) => Promise<unknown>;
}

// Every exchange checks the output barrier, including requests that emit
// nothing. A warning, critical or error fails it.
export class PageSession {
  private lastSeq = 0;
  readonly host: RunningHost;
  private readonly options: SessionOptions;
  private constructor(host: RunningHost, options: SessionOptions) {
    this.host = host;
    this.options = options;
  }

  static async start(
    h: Harness,
    runtime: RuntimeBuild,
    manifest: ModuleManifest,
    options: SessionOptions,
  ): Promise<PageSession> {
    const engine = { ...manifest, name: `${manifest.name}-${runtime.name}-${crypto.randomUUID()}` };
    const host = await h.start({
      runtime,
      manifest: engine,
      storage: h.storage(engine),
      test: { sides: h.sides.filter((side) => side.name === "settings") },
    });
    const session = new PageSession(host, options);
    try {
      await session.request(0, new Init({ version: PROTOCOL_VERSION, settings: options.settings }));
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

  // Activates an engine as the page's router does, enabling it before its
  // first focus.
  async create(ic: number, engine = this.options.engine): Promise<void> {
    await this.request(ic, new CreateEngine({ name: engine }));
    await this.request(ic, new SetCapabilities({ capabilities: CAPABILITIES }));
    await this.request(ic, new Enable({}));
    await this.request(ic, new FocusIn({}));
    await this.options.ready?.(this, ic);
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
