// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { ProcessKeyEvent, type DecodedRecord, type EngineManifest, type Request } from "@ibus-web/protocol";
import type { Connection, CrashInfo, Reply } from "../connection/connection.ts";
import { translateKey } from "../keys/translate.ts";
import { ReplayQueue, type KeySink, type KeyResult, type AsyncKeyResult, type SurfaceAdapter } from "./replay.ts";
export type EngineState = "starting" | "ready" | "busy" | "restarting" | "failed";
export type KeyConnection = Pick<
  Connection,
  "busy" | "requestSync" | "requestAsync" | "onDoorbell" | "onCrash" | "records" | "replies" | "terminate"
>;
export interface EngineSnapshot {
  readonly name: string;
  manifest?: EngineManifest;
  status: EngineState;
  enabled: boolean;
  generation: number;
  connection: KeyConnection | undefined;
  keyboard: EngineManifest["keyboard"];
  passThrough: ReadonlySet<number>;
}
/** apply and consumed run inside the adapter transaction and must only do synchronous work. */
export interface KeyContext {
  readonly ic: number;
  generation: number;
  ready: boolean;
  readonly adapter: SurfaceAdapter;
  apply(record: DecodedRecord): void;
  consumed(): void;
  invalidate(): void;
}
interface PendingKey {
  readonly context: KeyContext;
  readonly event: KeyboardEvent;
  readonly request: Request;
  readonly generation: number;
  retired?: boolean;
  readonly completion?: { resolve(result: AsyncKeyResult): void; reject(cause: unknown): void };
}
export interface RouterOutput {
  readonly replayLimit: number;
  enqueue(record: DecodedRecord): void;
  hide(ic: number): void;
  crashed(crash: CrashInfo): void;
}
export class KeyRouter {
  private readonly contexts = new Map<number, KeyContext>();
  private readonly replay: ReplayQueue<PendingKey>;
  private readonly accepted = new Set<PendingKey>();
  private readonly drains = new Set<{ keys: Set<PendingKey>; resolve: () => void }>();
  private active: PendingKey | undefined;
  private activeMode: "sync" | "abandoned" | "async" | undefined;
  private lifecycle = 0;
  private unsubscribe: (() => void)[] = [];
  readonly snapshot: EngineSnapshot;
  private readonly output: RouterOutput;
  constructor(snapshot: EngineSnapshot, output: RouterOutput) {
    this.snapshot = snapshot;
    this.output = output;
    this.replay = new ReplayQueue(output.replayLimit);
  }
  get busy(): boolean {
    return !!this.active || this.replay.size > 0 || this.lifecycle > 0 || !!this.snapshot.connection?.busy;
  }
  connect(connection: KeyConnection): void {
    this.disconnect();
    this.snapshot.connection = connection;
    this.unsubscribe = [
      connection.onCrash((crash) => this.crashed(crash)),
      connection.onDoorbell(() => {
        if (this.snapshot.connection !== connection) return;
        for (const reply of connection.replies.take()) {
          if (this.activeMode !== "abandoned") continue;
          this.complete(reply);
        }
        this.drainUnsolicited();
        this.next();
      }),
    ];
  }
  register(context: KeyContext): () => void {
    if (this.contexts.has(context.ic)) throw new Error(`Input context ${context.ic} already registered`);
    this.contexts.set(context.ic, context);
    return () => {
      if (this.contexts.get(context.ic) === context) this.contexts.delete(context.ic);
      context.ready = false;
      this.replay.remove((key) => key.context === context);
      for (const key of this.accepted)
        if (key.context === context) {
          key.retired = true;
          this.finished(key);
        }
    };
  }
  /** Wait only for keys already accepted for this context, not for global idleness. */
  drain(context: KeyContext): Promise<void> {
    const keys = new Set([...this.accepted].filter((key) => key.context === context));
    return new Promise((resolve) => {
      if (keys.size === 0) resolve();
      else this.drains.add({ keys, resolve });
    });
  }
  /** Replay before a synchronous caret/reset boundary while retaining wire ownership. */
  retire(context: KeyContext, beforeReplay?: () => void): void {
    const keys = [...this.accepted].filter((key) => key.context === context);
    this.replay.remove((key) => key.context === context);
    try {
      if (keys.length > 0 || beforeReplay)
        context.adapter.batch(() => {
          beforeReplay?.();
          for (const key of keys) {
            key.retired = true;
            this.fallback(key);
          }
        });
    } catch (error) {
      for (const key of keys) {
        key.retired = true;
        this.finished(key, { error });
      }
      throw error;
    }
  }

  private finished(key: PendingKey, result: AsyncKeyResult | { error: unknown } = "cancelled"): void {
    if (!this.accepted.delete(key)) return;
    if (key.completion) {
      const completion = key.completion;
      queueMicrotask(() => (typeof result === "string" ? completion.resolve(result) : completion.reject(result.error)));
    }
    for (const drain of this.drains) {
      drain.keys.delete(key);
      if (drain.keys.size === 0) {
        this.drains.delete(drain);
        // Retirement can run on a native event stack; settle awaiters off that stack.
        queueMicrotask(drain.resolve);
      }
    }
  }
  private ownedRecords(records: readonly DecodedRecord[], key: PendingKey): DecodedRecord[] {
    return records.filter(
      (record) =>
        record.record._tag === "Log" ||
        record.record._tag === "SettingWritten" ||
        record.ic !== key.context.ic ||
        (!key.retired && this.contexts.get(record.ic) === key.context),
    );
  }
  sink(context: KeyContext): KeySink {
    return { key: (event) => this.key(context, event) };
  }
  private attached(context: KeyContext): boolean {
    return this.contexts.get(context.ic) === context && context.generation === this.snapshot.generation;
  }
  private current(context: KeyContext): boolean {
    return context.ready && this.attached(context);
  }
  private prepare(context: KeyContext, event: KeyboardEvent): PendingKey | undefined {
    const snapshot = this.snapshot;
    if (
      !snapshot.enabled ||
      (snapshot.status !== "ready" && snapshot.status !== "busy") ||
      !this.current(context) ||
      context.adapter.contentType().disabled
    )
      return undefined;
    const translated = translateKey(event, snapshot.keyboard.layout);
    if (!translated || snapshot.passThrough.has(translated.keyval)) return undefined;
    const connection = snapshot.connection;
    if (!connection) return undefined;
    return {
      context,
      event,
      request: new ProcessKeyEvent(translated),
      generation: snapshot.generation,
    };
  }
  /** Invoke during event dispatch: only accepted keys are prevented, before this call returns. */
  keyAsync(context: KeyContext, event: KeyboardEvent): Promise<AsyncKeyResult> {
    const pending = this.prepare(context, event);
    if (!pending) return Promise.resolve("passthrough");
    event.preventDefault();
    event.stopPropagation();
    return new Promise((resolve, reject) => {
      const owner = { ...pending, completion: { resolve, reject } };
      this.accepted.add(owner);
      this.replay.push(owner);
      if (this.replay.size + (this.active ? 1 : 0) > this.replay.limit)
        this.crash({ reason: "hang", message: "Replay queue exceeded its limit" });
      else this.next();
    });
  }
  private key(context: KeyContext, event: KeyboardEvent): KeyResult {
    const pending = this.prepare(context, event);
    if (!pending) return "passthrough";
    const snapshot = this.snapshot,
      connection = snapshot.connection!;
    this.accepted.add(pending);
    if (this.busy) {
      this.replay.push(pending);
      if (this.replay.size + (this.active ? 1 : 0) > this.replay.limit)
        this.crash({ reason: "hang", message: "Replay queue exceeded its limit" });
      return "consumed";
    }
    // Install ownership before requestSync: it can call onCrash before returning.
    this.active = pending;
    this.activeMode = "sync";
    const outcome = connection.requestSync(pending.request, context.ic);
    if (outcome._tag === "crashed") {
      this.crash(outcome.crash);
      return "consumed";
    }
    if (outcome._tag === "pending") {
      this.activeMode = "abandoned";
      return "consumed";
    }
    this.active = undefined;
    this.activeMode = undefined;
    this.finished(pending);
    this.apply(
      this.ownedRecords(outcome.records, pending),
      !pending.retired && outcome.ret === 1 ? context : undefined,
    );
    const generation = snapshot.generation;
    queueMicrotask(() => {
      if (
        snapshot.connection === connection &&
        snapshot.generation === generation &&
        this.activeMode !== "async" &&
        this.lifecycle === 0
      )
        this.apply(connection.records.takeBuffered());
    });
    return pending.retired || outcome.ret === 1 ? "consumed" : "passthrough";
  }
  /** Lifecycle requests retain ownership until their promise's records have been applied. */
  async request(request: Request, ic: number): Promise<Reply> {
    const connection = this.snapshot.connection;
    if (!connection) throw new Error("Engine is unavailable");
    const generation = this.snapshot.generation;
    const owner = this.contexts.get(ic);
    this.lifecycle++;
    try {
      const reply = await connection.requestAsync(request, ic);
      if (this.snapshot.generation === generation)
        this.apply(reply.records.filter((record) => record.ic !== ic || this.contexts.get(ic) === owner));
      return reply;
    } finally {
      if (this.snapshot.generation === generation) {
        this.lifecycle--;
        this.drainUnsolicited();
        this.next();
      }
    }
  }
  apply(records: readonly DecodedRecord[], consumed?: KeyContext): void {
    const targets = new Set<KeyContext>();
    for (const record of records) {
      const context = this.contexts.get(record.ic);
      if (context && this.attached(context)) targets.add(context);
    }
    if (consumed && this.current(consumed)) targets.add(consumed);
    const batch = [...targets];
    const run = (index: number): void => {
      if (index < batch.length) {
        batch[index]!.adapter.batch(() => run(index + 1));
        return;
      }
      for (const record of records) {
        if (record.record._tag === "Log" || record.record._tag === "SettingWritten") this.output.enqueue(record);
        else {
          const context = this.contexts.get(record.ic);
          if (context && this.attached(context)) context.apply(record);
        }
      }
      if (consumed && this.current(consumed)) consumed.consumed();
    };
    run(0);
  }
  private fallback(pending: PendingKey): void {
    try {
      if (this.attached(pending.context)) {
        pending.context.adapter.replayKey(pending.event);
        this.finished(pending, "replayed");
      } else this.finished(pending);
    } catch (error) {
      this.finished(pending, { error });
      if (!pending.completion) throw error;
    }
  }
  private complete(reply: Reply): void {
    const pending = this.active;
    this.active = undefined;
    this.activeMode = undefined;
    if (!pending) return;
    try {
      if (pending.generation === this.snapshot.generation) {
        this.apply(
          this.ownedRecords(reply.records, pending),
          !pending.retired && reply.ret === 1 ? pending.context : undefined,
        );
        if (!pending.retired && this.attached(pending.context)) {
          if (reply.ret === 1) this.finished(pending, "consumed");
          else this.fallback(pending);
        }
      }
    } catch (error) {
      this.finished(pending, { error });
      if (!pending.completion) throw error;
    } finally {
      this.finished(pending);
    }
  }
  private drainUnsolicited(): void {
    if (this.activeMode === "async" || this.lifecycle > 0) return;
    const connection = this.snapshot.connection;
    if (connection) this.apply(connection.records.take());
  }
  private next(): void {
    const connection = this.snapshot.connection;
    if (!connection || connection.busy || this.active || this.lifecycle > 0) return;
    let pending: PendingKey | undefined;
    do {
      pending = this.replay.shift();
      if (pending && !this.current(pending.context)) this.finished(pending);
    } while (pending && !this.current(pending.context));
    if (!pending) return;
    this.active = pending;
    this.activeMode = "async";
    const owner = pending;
    const failed = () => {
      if (this.active === owner && this.snapshot.connection === connection)
        this.crash({ reason: "worker", message: "Asynchronous key request failed" });
    };
    try {
      void connection.requestAsync(pending.request, pending.context.ic).then((reply) => {
        if (this.active !== owner || this.snapshot.connection !== connection) return;
        this.complete(reply);
        this.drainUnsolicited();
        this.next();
      }, failed);
    } catch {
      failed();
    }
  }

  crash(crash: CrashInfo): void {
    this.snapshot.connection?.terminate(crash);
    this.crashed(crash);
  }
  private crashed(crash: CrashInfo): void {
    if (!this.snapshot.connection) return;
    const connection = this.snapshot.connection;
    this.disconnect();
    this.snapshot.connection = undefined;
    this.snapshot.status = "restarting";
    const events = [...(this.active ? [this.active] : []), ...this.replay.take()];
    this.active = undefined;
    this.activeMode = undefined;
    this.lifecycle = 0;
    const failures: unknown[] = [];
    for (const pending of events) {
      try {
        if (!pending.retired) this.fallback(pending);
        else this.finished(pending);
      } catch (error) {
        // One surface's callback must not strand another surface's accepted keys.
        failures.push(error);
      }
    }
    this.snapshot.generation++;
    for (const context of this.contexts.values()) {
      context.ready = false;
      try {
        context.adapter.batch(() => {
          context.adapter.setPreedit(undefined);
          context.invalidate();
        });
        this.output.hide(context.ic);
      } catch (error) {
        failures.push(error);
      }
    }
    connection.terminate();
    this.output.crashed(crash);
    if (failures.length > 0) throw failures[0];
  }
  disconnect(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
  }
  dispose(): void {
    this.disconnect();
    this.snapshot.connection?.terminate();
    this.snapshot.connection = undefined;
    this.snapshot.status = "failed";
    this.contexts.clear();
    this.active = undefined;
    this.replay.take();
    for (const pending of this.accepted) this.finished(pending);
  }
}
