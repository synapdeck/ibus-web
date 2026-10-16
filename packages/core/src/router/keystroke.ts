// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  Persist,
  ProcessKeyEvent,
  Shutdown,
  type DecodedLazyRecord,
  type ModuleManifest,
  type Request,
} from "@ibus-web/protocol";
import type { Connection, CrashInfo, Reply } from "../connection/connection.ts";
import { translateKey } from "../keys/translate.ts";
import { ReplayQueue, type KeySink, type KeyResult, type AsyncKeyResult, type SurfaceAdapter } from "./replay.ts";
export type ModuleState = "starting" | "ready" | "busy" | "restarting" | "failed" | "unloaded";
export type KeyConnection = Pick<
  Connection,
  "busy" | "requestSync" | "requestAsync" | "onDoorbell" | "onCrash" | "records" | "replies" | "terminate" | "prepare"
> &
  Partial<Pick<Connection, "poll" | "checkStorage">>;
export interface KeyboardPolicy {
  readonly layout: "us" | "default";
  readonly passThrough: ReadonlySet<number>;
}
export interface ModuleSnapshot {
  readonly name: string;
  manifest?: ModuleManifest;
  status: ModuleState;
  enabled: boolean;
  generation: number;
  connection: KeyConnection | undefined;
  /** By engine name; empty until the manifest has loaded. */
  keyboards: ReadonlyMap<string, KeyboardPolicy>;
}
/** apply and consumed run inside the adapter transaction and must only do synchronous work. */
export interface KeyContext {
  readonly ic: number;
  /** The engine created in this context, whose keyboard policy its keys follow. */
  readonly engine: string;
  generation: number;
  ready: boolean;
  readonly adapter: SurfaceAdapter;
  apply(record: DecodedLazyRecord): void;
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
  /** Enqueue-only observer; never run an Effect on the key stack. */
  changed?(): void;
  enqueue(record: DecodedLazyRecord): void;
  hide(ic: number): void;
  crashed(crash: CrashInfo): void;
  /** Reports page callback errors from background work without restarting the engine. */
  error?(cause: unknown, ic: number): void;
}
/**
 * Records a retired key still applies. The page replayed the key natively, so its edits would apply twice, and its
 * preedit, lookup table and auxiliary text draw a composition the retiring boundary has already ended. Properties
 * describe the engine's modes rather than that composition, and nothing sends them again: dropping a session's first
 * RegisterProperties would leave the panel without them until the next focus.
 */
const engineState: ReadonlySet<string> = new Set(["RegisterProperties", "UpdateProperty"]);

export class KeyRouter {
  private readonly contexts = new Map<number, KeyContext>();
  private readonly replay: ReplayQueue<PendingKey>;
  private readonly accepted = new Set<PendingKey>();
  private readonly replaying = new Set<PendingKey>();
  private readonly drains = new Set<{ keys: Set<PendingKey>; resolve: () => void }>();
  private active: PendingKey | undefined;
  private activeMode: "sync" | "abandoned" | "async" | undefined;
  /** Reservations from holdKeys; only their owner can release them, so keys never overtake one. */
  private holds = 0;
  /** In-flight lifecycle requests; a key may settle one whose reply has already arrived. */
  private requests = 0;
  private unsubscribe: (() => void)[] = [];
  readonly snapshot: ModuleSnapshot;
  private readonly output: RouterOutput;
  constructor(snapshot: ModuleSnapshot, output: RouterOutput) {
    this.snapshot = snapshot;
    this.output = output;
    this.replay = new ReplayQueue(output.replayLimit);
  }
  private get lifecycle(): number {
    return this.holds + this.requests;
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
        const ic = this.active?.context.ic ?? 0;
        try {
          for (const reply of connection.replies.take()) {
            if (this.activeMode !== "abandoned") continue;
            this.complete(reply);
          }
          this.drainUnsolicited();
        } catch (cause) {
          // Returning to the connection lets its lifecycle/settings FIFO advance too.
          this.reportError(cause, ic);
        } finally {
          this.next();
        }
      }),
    ];
  }
  private reportError(cause: unknown, ic: number): void {
    queueMicrotask(() => {
      if (this.output.error) this.output.error(cause, ic);
      else throw cause;
    });
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
  /** Capture boundary owners synchronously; allocate the wait only when lifecycle work runs. */
  captureDrain(context: KeyContext): () => Promise<void> {
    const owners = [...this.accepted].filter((key) => key.context === context);
    return () =>
      new Promise((resolve) => {
        const keys = new Set(owners.filter((key) => this.accepted.has(key)));
        if (keys.size === 0) resolve();
        else this.drains.add({ keys, resolve });
      });
  }
  /** Wait only for keys already accepted for this context, not for global idleness. */
  drain(context: KeyContext): Promise<void> {
    return this.captureDrain(context)();
  }
  /** Replay before a synchronous caret/reset boundary while retaining wire ownership. */
  retire(context: KeyContext, beforeReplay?: () => void): void {
    // A replayed key can raise this boundary itself, as a replayed undo does. The keys queued behind it were
    // typed after that edit, so they stay queued for the engine rather than being replayed raw.
    const reentrant = [...this.replaying].some((key) => key.context === context);
    const keys = reentrant ? [] : [...this.accepted].filter((key) => key.context === context);
    if (!reentrant) this.replay.remove((key) => key.context === context);
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
  private ownedRecords(records: readonly DecodedLazyRecord[], key: PendingKey): DecodedLazyRecord[] {
    return records.filter(
      (record) =>
        record.record._tag === "Log" ||
        record.record._tag === "SettingWritten" ||
        record.ic !== key.context.ic ||
        (this.contexts.get(record.ic) === key.context && (!key.retired || engineState.has(record.record._tag))),
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
    const keyboard = snapshot.keyboards.get(context.engine);
    if (!keyboard) return undefined;
    // Meta is Command on Apple platforms and Super elsewhere: its chords are the browser's and the system's shortcuts.
    // Engines that don't know the modifier, as Mozc doesn't, would type the key instead.
    if (event.getModifierState("Meta")) return undefined;
    const translated = translateKey(event, keyboard.layout);
    if (!translated || keyboard.passThrough.has(translated.keyval)) return undefined;
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

    // A lifecycle reply lands in shared memory well before its doorbell message. Reading it here keeps the
    // key synchronous, and with it the browser's default action if the engine declines the key.
    if (this.busy && !this.active && this.replay.size === 0 && this.holds === 0) {
      connection.poll?.();
      if (snapshot.connection !== connection || !this.current(context)) return "passthrough";
    }

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
      this.output.changed?.();
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
  /** Reserve wire ordering before an asynchronous lifecycle operation is scheduled. */
  holdKeys(): () => void {
    const connection = this.snapshot.connection;
    const generation = this.snapshot.generation;
    this.holds++;
    this.output.changed?.();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.snapshot.connection !== connection || this.snapshot.generation !== generation) return;
      this.holds--;
      this.output.changed?.();
      this.drainUnsolicited();
      this.next();
    };
  }
  /** Lifecycle requests retain ownership until their promise's records have been applied. */
  async request(request: Request, ic: number): Promise<Reply> {
    const connection = this.snapshot.connection;
    if (!connection) throw new Error("Engine is unavailable");
    const generation = this.snapshot.generation;
    const owner = this.contexts.get(ic);
    let open = true;
    let failure: { cause: unknown } | undefined;

    // The connection can call this from inside a key handler that then decides whether to queue its key, so
    // the request must be released synchronously and its errors kept for the awaiting caller.
    const settle = (reply?: Reply) => {
      if (!open) return;
      open = false;
      if (this.snapshot.generation !== generation) return;
      try {
        if (reply) this.apply(reply.records.filter((record) => record.ic !== ic || this.contexts.get(ic) === owner));
      } catch (cause) {
        failure = { cause };
      } finally {
        this.requests--;
        this.output.changed?.();
      }
      try {
        this.drainUnsolicited();
      } catch (cause) {
        failure ??= { cause };
      }
    };

    this.requests++;
    this.output.changed?.();
    try {
      const reply = await connection.requestAsync(request, ic, { settled: settle });
      // A connection that ignores the hook leaves the request to be settled here.
      settle(reply);
      if (failure) throw failure.cause;
      return reply;
    } finally {
      settle();
      if (this.snapshot.generation === generation) this.next();
    }
  }
  /**
   * Has the host persist what its engines keep in memory. Given a budget and nothing else on the wire, the request
   * goes out at once and this waits up to `budgetMs` for its reply, so that the work is done before a page that is
   * going away returns to the browser. Otherwise it queues behind the work ahead of it, and the page's event loop
   * must go on for it to be sent and answered.
   */
  persist(budgetMs?: number): void {
    const connection = this.snapshot.connection;
    if (!connection || (this.snapshot.status !== "ready" && this.snapshot.status !== "busy")) return;

    if (this.busy && !this.active && this.replay.size === 0 && this.holds === 0) connection.poll?.();
    if (this.snapshot.connection !== connection) return;
    if (budgetMs === undefined || this.busy) {
      void this.request(new Persist({}), 0).catch((cause: unknown) => this.reportError(cause, 0));
      return;
    }

    const outcome = connection.requestSync(new Persist({}), 0, budgetMs);
    if (outcome._tag === "crashed") this.crash(outcome.crash);
    else if (outcome._tag === "reply") this.apply(outcome.records);
    else this.output.changed?.();
  }
  /**
   * Has the host persist what its engines keep in memory, then release what its modules hold, before the page ends
   * the Worker. Each request waits up to `budgetMs` for its reply while nothing else is on the wire; one that can't
   * goes out behind the work ahead of it, which the Worker ending may cut short.
   */
  shutdown(budgetMs: number): void {
    const connection = this.snapshot.connection;
    if (!connection || (this.snapshot.status !== "ready" && this.snapshot.status !== "busy")) return;

    this.persist(budgetMs);
    if (this.snapshot.connection !== connection) return;
    if (this.busy) {
      void this.request(new Shutdown({}), 0).catch((cause: unknown) => this.reportError(cause, 0));
      return;
    }

    const outcome = connection.requestSync(new Shutdown({}), 0, budgetMs);
    if (outcome._tag === "crashed") this.crash(outcome.crash);
    else if (outcome._tag === "reply") this.apply(outcome.records);
    else this.output.changed?.();
  }
  apply(records: readonly DecodedLazyRecord[], consumed?: KeyContext): void {
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
        this.replaying.add(pending);
        try {
          if (pending.context.adapter.replayKey(pending.event) === false) this.lost(pending);
        } finally {
          this.replaying.delete(pending);
        }
        this.finished(pending, "replayed");
      } else this.finished(pending);
    } catch (error) {
      this.finished(pending, { error });
      if (!pending.completion) throw error;
    }
  }
  /** The router prevented this key's default and the adapter could not perform it, so say what the user lost. */
  private lost({ context, event }: PendingKey): void {
    const chord = [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta"]
      .filter(Boolean)
      .concat(event.key)
      .join("+");
    this.output.enqueue({
      seq: 0,
      ic: context.ic,
      flags: 0,
      size: 0,
      record: {
        _tag: "Log",
        level: 16,
        domain: "page-adapter",
        message: `The page could not replay ${chord}, so its browser action was lost`,
      },
    });
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
      this.output.changed?.();
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
    this.output.changed?.();
    const owner = pending;
    const failed = () => {
      if (this.active === owner && this.snapshot.connection === connection)
        this.crash({ reason: "worker", message: "Asynchronous key request failed" });
    };
    try {
      void connection
        .requestAsync(pending.request, pending.context.ic)
        .then((reply) => {
          if (this.active !== owner || this.snapshot.connection !== connection) return;
          try {
            this.complete(reply);
            this.drainUnsolicited();
          } finally {
            this.next();
          }
        }, failed)
        .catch((cause) => this.reportError(cause, owner.context.ic));
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
    this.holds = 0;
    this.requests = 0;
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
    this.activeMode = undefined;
    this.holds = 0;
    this.requests = 0;
    this.contexts.clear();
    this.active = undefined;
    this.replay.take();
    for (const pending of this.accepted) this.finished(pending);
  }
}
