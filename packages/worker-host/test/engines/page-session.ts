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
// with URLs as this environment fetches them, the heap and pool it is held
// to, and texts its build computed.
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
  patterns?: Init["patterns"];
  // The engine create() makes unless told another.
  engine: string;
  // Runs once a context's engine is created and focused.
  ready?: (session: PageSession, ic: number) => Promise<unknown>;
  // The messages a module logs as a deployment of its data starts and
  // ends; its first start counts as one. Warnings in between are kept in
  // deploymentWarnings rather than failed, for a module whose deployments
  // warn of what a new user directory lacks or of its own configs.
  deployment?: { start: string; end: string };
  // Another session whose storage this one shares, as a second tab of the
  // module does; a fresh storage of its own if none.
  sharing?: PageSession;
}

// Every exchange checks the output barrier, including requests that emit
// nothing. A critical or error fails it, and so does a warning outside a
// deployment.
export class PageSession {
  private lastSeq = 0;
  private deploying: boolean;
  readonly deploymentWarnings: string[] = [];
  readonly logs: string[] = [];
  // How long start's Init and first CreateEngine took.
  readonly timings = { initMs: 0, createMs: 0 };
  readonly host: RunningHost;
  readonly manifest: ModuleManifest;
  private readonly options: SessionOptions;
  private constructor(host: RunningHost, manifest: ModuleManifest, options: SessionOptions) {
    this.host = host;
    this.manifest = manifest;
    this.options = options;
    this.deploying = options.deployment !== undefined;
  }

  static async start(
    h: Harness,
    runtime: RuntimeBuild,
    manifest: ModuleManifest,
    options: SessionOptions,
  ): Promise<PageSession> {
    const engine = options.sharing?.manifest ?? {
      ...manifest,
      name: `${manifest.name}-${runtime.name}-${crypto.randomUUID()}`,
    };
    const host = await h.start({
      runtime,
      manifest: engine,
      storage: h.storage(engine),
      test: { sides: h.sides.filter((side) => side.name === "settings") },
    });
    const session = new PageSession(host, engine, options);
    try {
      // As the page does: a host that reported read-only storage keeps it for its life.
      const userDataWritable = !host.messages.some(
        (message) => message.type === "storage" && message.state === "read-only",
      );
      const begin = performance.now();
      await session.request(
        0,
        new Init({
          version: PROTOCOL_VERSION,
          userDataWritable,
          settings: options.settings,
          patterns: options.patterns ?? [],
        }),
      );
      const initialized = performance.now();
      await session.create(1);
      session.timings.initMs = initialized - begin;
      session.timings.createMs = performance.now() - initialized;
      return session;
    } catch (error) {
      await host.terminate();
      throw error;
    }
  }

  // Takes what the host has published to the ring, as a page does on a
  // doorbell.
  read(): DecodedRecord[] {
    const records = this.host.client.page.records();
    for (const { seq, record } of records) {
      if (seq !== 0) {
        expect(seq).toBe((this.lastSeq + 1) >>> 0 || 1);
        this.lastSeq = seq;
      }
      if (record._tag !== "Log") continue;
      this.logs.push(record.message);
      if (record.message === this.options.deployment?.start) this.deploying = true;
      if (record.message === this.options.deployment?.end) this.deploying = false;
      if (this.deploying && (record.level & (4 | 8 | 16)) === 16) this.deploymentWarnings.push(record.message);
      else expect(record.level & (4 | 8 | 16), record.message).toBe(0);
    }
    return records;
  }

  // The host keeps pumping after it publishes a reply, so a record another
  // thread emitted can reach the ring after the reply's and be read with it.
  private checkRecords(outSeq: number): DecodedRecord[] {
    const records = this.read();
    expect((this.lastSeq - outSeq) >>> 0, `records through ${outSeq}`).toBeLessThan(2 ** 31);
    return records;
  }

  async request(ic: number, request: Request, ret = 0): Promise<DecodedRecord[]> {
    const reply = await this.exchange(ic, request);
    expect(reply.ret, request._tag).toBe(ret);
    return reply.records;
  }

  private async exchange(ic: number, request: Request): Promise<{ ret: number; records: DecodedRecord[] }> {
    this.host.client.page.post(encodeRequest(ic, request), ReqMode.sync);
    const reply = await this.host.client.page.waitForReply();
    return { ret: reply.ret, records: this.checkRecords(reply.outSeq) };
  }

  async key(ic: number, keyval: number, keycode: number, ret = 1): Promise<DecodedRecord[]> {
    const press = await this.request(ic, new ProcessKeyEvent({ keyval, keycode, state: 0 }), ret);
    const release = await this.request(ic, new ProcessKeyEvent({ keyval, keycode, state: 1 << 30 }), 0);
    return [...press, ...release];
  }

  // A key as the router sends it, whether or not the engine takes it: a
  // declined press is one the browser still acts on.
  async press(ic: number, keyval: number, keycode: number): Promise<{ handled: boolean; records: DecodedRecord[] }> {
    const press = await this.exchange(ic, new ProcessKeyEvent({ keyval, keycode, state: 0 }));
    expect([0, 1], "ProcessKeyEvent").toContain(press.ret);
    const release = await this.request(ic, new ProcessKeyEvent({ keyval, keycode, state: 1 << 30 }), 0);
    return { handled: press.ret === 1, records: [...press.records, ...release] };
  }

  // Activates an engine as the page's router does: its own data prepared,
  // then the engine made and enabled before its first focus.
  async create(ic: number, engine = this.options.engine): Promise<void> {
    if ((this.manifest.engines.find(({ name }) => name === engine)?.data ?? []).length > 0) {
      const prepared = await this.host.prepare(engine);
      expect(prepared.error, `preparing ${engine}`).toBeUndefined();
    }
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
