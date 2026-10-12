// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { Request, DecodedLazyRecord } from "@ibus-web/protocol";
import type { Reply, SyncOutcome, CrashInfo, PrepareProgress } from "../../src/connection/connection.ts";
import { KeyRouter, type ModuleSnapshot, type KeyContext, type KeyConnection } from "../../src/router/keystroke.ts";
import type { SurfaceAdapter } from "../../src/router/replay.ts";
export const key = (value: string): KeyboardEvent =>
  ({
    key: value,
    code: value.length === 1 && /[a-z]/.test(value) ? `Key${value.toUpperCase()}` : "KeyA",
    type: "keydown",
    isComposing: false,
    repeat: false,
    getModifierState: () => false,
  }) as unknown as KeyboardEvent;
export const ctrl = (value: string): KeyboardEvent =>
  ({
    ...key(value),
    ctrlKey: true,
    getModifierState: (modifier: string) => modifier === "Control",
  }) as unknown as KeyboardEvent;
export const output = (seq: number): DecodedLazyRecord => ({
  seq,
  ic: 1,
  flags: 0,
  size: 16,
  record: { _tag: "HidePreeditText" },
});
export class FakeConnection implements KeyConnection {
  busy = false;
  terminated = false;
  outcome: SyncOutcome = { _tag: "reply", ret: 1, records: [] };
  duringSync: (() => void) | undefined;
  sent: { mode: string; ic: number; request: Request }[] = [];
  abandoned: Reply[] = [];
  records = { take: () => [], takeBuffered: () => [] };
  replies = { take: () => this.abandoned.splice(0) };
  bells = new Set<() => void>();
  crashes = new Set<(crash: CrashInfo) => void>();
  pending: {
    resolve: (r: Reply) => void;
    reject: (e: unknown) => void;
    settled: ((r: Reply) => void) | undefined;
    ready?: Reply;
  }[] = [];
  polls = 0;
  // The engines prepared, in order; prepareWith answers each.
  prepared: string[] = [];
  prepareWith: (engine: string, progress: PrepareProgress | undefined) => Promise<void> = async () => {};
  prepare(engine: string, progress?: PrepareProgress): Promise<void> {
    this.prepared.push(engine);
    return this.prepareWith(engine, progress);
  }
  onDoorbell(f: () => void) {
    this.bells.add(f);
    return () => {
      this.bells.delete(f);
    };
  }
  onCrash(f: (c: CrashInfo) => void) {
    this.crashes.add(f);
    return () => {
      this.crashes.delete(f);
    };
  }
  requestSync(request: Request, ic: number) {
    this.sent.push({ mode: "sync", request, ic });
    this.duringSync?.();
    if (this.terminated) return { _tag: "crashed", crash: { reason: "worker", message: "crash" } } as const;
    this.busy = this.outcome._tag === "pending";
    return this.outcome;
  }
  requestAsync(request: Request, ic: number, options?: { settled?: (reply: Reply) => void }): Promise<Reply> {
    this.sent.push({ mode: "async", request, ic });
    this.busy = true;
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject, settled: options?.settled }));
  }
  completeAsync(ret = 1, records: DecodedLazyRecord[] = []) {
    this.settle({ ret, records, outSeq: records.at(-1)?.seq ?? 0 });
    this.bell();
  }
  /** The reply is in shared memory, but its doorbell message has not arrived. */
  readyAsync(ret = 1, records: DecodedLazyRecord[] = []) {
    this.pending[0]!.ready = { ret, records, outSeq: records.at(-1)?.seq ?? 0 };
  }
  poll() {
    this.polls++;
    const ready = this.pending[0]?.ready;
    if (!ready) return;
    this.settle(ready);
    this.bell();
  }
  private settle(reply: Reply) {
    const pending = this.pending.shift()!;
    this.busy = false;
    pending.settled?.(reply);
    pending.resolve(reply);
  }
  completeAbandoned(ret: number, records: DecodedLazyRecord[] = []) {
    this.busy = false;
    this.abandoned.push({ ret, records, outSeq: records.at(-1)?.seq ?? 0 });
    this.bell();
  }
  bell() {
    for (const f of this.bells) f();
  }
  crash(crash: CrashInfo = { reason: "worker", message: "crash" }) {
    if (this.terminated) return;
    this.terminated = true;
    this.busy = false;
    for (const p of this.pending.splice(0)) p.reject(crash);
    for (const f of this.crashes) f(crash);
  }
  terminate(crash?: CrashInfo) {
    this.crash(crash);
  }
}
export function fixture() {
  const calls: string[] = [],
    logs: DecodedLazyRecord[] = [],
    hidden: number[] = [],
    crashes: CrashInfo[] = [],
    errors: unknown[] = [];
  const connection = new FakeConnection();
  const snapshot: ModuleSnapshot = {
    name: "test",
    status: "ready",
    enabled: true,
    generation: 0,
    connection,
    keyboards: new Map([["test", { layout: "us", passThrough: new Set() }]]),
  };
  const adapter = {
    batch: (apply: () => void) => {
      calls.push("batch");
      apply();
      calls.push("end");
    },
    setPreedit: () => calls.push("clear"),
    replayKey: (event: KeyboardEvent) => calls.push(`replay:${event.key}`),
    contentType: () => ({ purpose: 0, hints: 0, disabled: false }),
  } as unknown as SurfaceAdapter;
  const context: KeyContext = {
    ic: 1,
    engine: "test",
    generation: 0,
    ready: true,
    adapter,
    apply: (record) => calls.push(`record:${record.seq}`),
    consumed: () => calls.push("consumed"),
    invalidate: () => calls.push("invalidate"),
  };
  const router = new KeyRouter(snapshot, {
    replayLimit: 64,
    enqueue: (record) => logs.push(record),
    hide: (ic) => hidden.push(ic),
    crashed: (crash) => crashes.push(crash),
    error: (cause) => errors.push(cause),
  });
  router.connect(connection);
  const unregister = router.register(context);
  return {
    calls,
    logs,
    hidden,
    crashes,
    errors,
    connection,
    snapshot,
    context,
    router,
    unregister,
    sink: router.sink(context),
  };
}
