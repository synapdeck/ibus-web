// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  decodeRecordLazy,
  encodeRequest,
  ProtocolError,
  requestKinds,
  RingReader,
  type DecodedLazyRecord,
  type Request,
} from "@ibus-web/protocol";
import {
  createControl,
  controlViews,
  postRequest,
  takeReply,
  ReqMode,
  State,
  Word,
  transportLayout,
  type TransportLayout,
  type HostInit,
  type HostMessage,
  type ControlViews,
  type StorageState,
} from "@ibus-web/worker-host";
import { crashFromRecord, type CrashInfo } from "./crash.ts";
import { ConnectionBusyError, type QueuedRequest, type Reply } from "./requests.ts";
export type { CrashInfo } from "./crash.ts";
export { ConnectionBusyError } from "./requests.ts";
export type { Reply } from "./requests.ts";
export interface ConnectionOptions {
  hostUrl: URL;
  runtimeUrl: URL;
  manifestUrl: URL;
  storage: "browser" | "none";
  layout?: TransportLayout;
  budgetMs: number;
  hangMs: number;
  /** Init may load persistent engine data before producing output; defaults to 30 seconds. */
  initHangMs?: number;
  worker?: (url: URL) => Worker;
  /** Cancels startup only; an established connection is owned by its caller. */
  signal?: AbortSignal;
  /** Throw malformed-record diagnostics instead of logging and dropping them. */
  development?: boolean;
}
export type SyncOutcome =
  | { _tag: "reply"; ret: number; records: DecodedLazyRecord[] }
  | { _tag: "pending" }
  | { _tag: "crashed"; crash: CrashInfo };
const modules = new Map<string, Promise<WebAssembly.Module>>();
function compile(runtimeUrl: URL): Promise<WebAssembly.Module> {
  const url = new URL("ibus-runtime.wasm", runtimeUrl);
  let pending = modules.get(url.href);
  if (!pending) {
    pending = WebAssembly.compileStreaming(fetch(url));
    modules.set(url.href, pending);
    void pending.catch(() => {
      if (modules.get(url.href) === pending) modules.delete(url.href);
    });
  }
  return pending;
}
/** Cancel this caller's wait without interrupting the shared compilation. */
function waitForCompilation(pending: Promise<WebAssembly.Module>, signal?: AbortSignal): Promise<WebAssembly.Module> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(
      (module) => {
        signal.removeEventListener("abort", abort);
        resolve(module);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
export class Connection {
  private readonly reader: RingReader;
  private readonly output: DecodedLazyRecord[] = [];
  private readonly abandoned: Reply[] = [];
  private readonly doorbells = new Set<() => void>();
  private readonly crashes = new Set<(crash: CrashInfo) => void>();
  private readonly queue: QueuedRequest[] = [];
  private current: QueuedRequest | undefined;
  private inFlight = false;
  private crash: CrashInfo | undefined;
  private storage: StorageState | undefined;
  private seq = 0;
  private movedAt = 0;
  private requestHangMs = 0;
  private ringWrite = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deferred: ReturnType<typeof setTimeout> | undefined;
  private ready = false;
  private resolveStart: (() => void) | undefined;
  private rejectStart: ((error: unknown) => void) | undefined;
  private readonly options: ConnectionOptions;
  private readonly worker: Worker;
  private readonly control: ControlViews;
  private constructor(options: ConnectionOptions, worker: Worker, control: ControlViews, layout: TransportLayout) {
    this.options = options;
    this.worker = worker;
    this.control = control;
    this.reader = new RingReader(control, layout);
    worker.addEventListener("message", this.message);
    worker.addEventListener("error", this.error);
    worker.addEventListener("messageerror", this.error);
  }
  static async start(options: ConnectionOptions): Promise<Connection> {
    if (
      !Number.isFinite(options.budgetMs) ||
      options.budgetMs < 0 ||
      !Number.isFinite(options.hangMs) ||
      options.hangMs <= 0 ||
      !Number.isFinite(options.initHangMs ?? 30000) ||
      (options.initHangMs ?? 30000) <= 0
    )
      throw new RangeError("budgetMs must be nonnegative; hangMs and initHangMs must be finite and positive");
    options.signal?.throwIfAborted();
    const wasm = await waitForCompilation(compile(options.runtimeUrl), options.signal);
    options.signal?.throwIfAborted();
    const layout = options.layout ?? transportLayout();
    const buffer = createControl(layout);
    const worker = options.worker?.(options.hostUrl) ?? new Worker(options.hostUrl, { type: "module" });
    const connection = new Connection(options, worker, controlViews(buffer, layout), layout);
    const started = new Promise<void>((resolve, reject) => {
      connection.resolveStart = resolve;
      connection.rejectStart = reject;
    });
    const init: HostInit<WebAssembly.Module> = {
      runtimeUrl: options.runtimeUrl.href,
      manifestUrl: options.manifestUrl.href,
      wasm,
      control: buffer,
      layout,
      storage: { kind: options.storage },
    };
    const abort = () => {
      connection.rejectStart?.(options.signal!.reason);
      connection.rejectStart = undefined;
      connection.resolveStart = undefined;
      connection.terminate({ reason: "load", message: "Connection startup aborted" });
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal?.aborted) abort();
      else {
        try {
          worker.postMessage(init);
        } catch (error) {
          connection.fail({ reason: "load", message: String(error) });
        }
      }
      await started;
      options.signal?.throwIfAborted();
      return connection;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }
  get busy(): boolean {
    return this.inFlight || this.queue.length > 0;
  }
  /** Completed abandoned requests, in publication order. Async replies belong to their promises. */
  readonly replies = { take: (): Reply[] => this.abandoned.splice(0) };
  readonly records = {
    /** Only decoded output; a deferred sync tail must not chase a live producer. */
    takeBuffered: (): DecodedLazyRecord[] => {
      this.checkCrash();
      return this.crash || this.inFlight ? [] : this.output.splice(0);
    },
    take: (): DecodedLazyRecord[] => {
      this.drain();
      this.checkCrash();
      return this.inFlight ? [] : this.output.splice(0);
    },
  };
  onDoorbell(listener: () => void): () => void {
    this.doorbells.add(listener);
    return () => {
      this.doorbells.delete(listener);
    };
  }
  onCrash(listener: (crash: CrashInfo) => void): () => void {
    this.crashes.add(listener);
    return () => {
      this.crashes.delete(listener);
    };
  }
  requestSync(request: Request, ic: number): SyncOutcome {
    const deadline = performance.now() + this.options.budgetMs;
    const canContinue = () => performance.now() < deadline;
    this.drain(canContinue);
    this.checkCrash();
    if (this.crash) return { _tag: "crashed", crash: this.crash };
    if (this.busy) throw new ConnectionBusyError();
    if (!this.publish(encodeRequest(ic, request), ReqMode.sync, canContinue))
      return { _tag: "crashed", crash: this.crash! };
    do {
      this.drain(canContinue);
      this.checkCrash();
      if (this.crash) return { _tag: "crashed", crash: this.crash };
      const reply = this.complete(canContinue);
      this.checkCrash();
      if (this.crash) return { _tag: "crashed", crash: this.crash };
      if (reply) return { _tag: "reply", ret: reply.ret, records: reply.records };
    } while (canContinue());
    Atomics.compareExchange(this.control.words, Word.reqMode, ReqMode.sync, ReqMode.abandoned);
    this.checkCrash();
    if (this.crash) return { _tag: "crashed", crash: this.crash };
    const reply = this.complete(canContinue);
    this.checkCrash();
    if (this.crash) return { _tag: "crashed", crash: this.crash };
    if (reply) return { _tag: "reply", ret: reply.ret, records: reply.records };
    // The host may have observed SYNC before abandonment and omitted its doorbell.
    // Unread output must finish off the synchronous path without dispatching the key again.
    if (Atomics.load(this.control.words, Word.state) === State.reply) {
      this.deferred = setTimeout(() => {
        this.deferred = undefined;
        this.doorbell();
      }, 0);
    }
    this.watch();
    return { _tag: "pending" };
  }
  requestAsync(request: Request, ic: number): Promise<Reply> {
    this.drain();
    this.checkCrash();
    if (this.crash) return Promise.reject(this.crash);
    const bytes = encodeRequest(ic, request);
    if (bytes.length > this.control.slot.length)
      return Promise.reject(new RangeError(`request of ${bytes.length} bytes`));
    return new Promise((resolve, reject) => {
      this.queue.push({ bytes, resolve, reject });
      this.next();
    });
  }
  terminate(crash: CrashInfo = { reason: "worker", message: "Connection terminated" }): void {
    this.fail(crash);
  }
  private publish(bytes: Uint8Array, mode: number, canContinue?: () => boolean): boolean {
    try {
      postRequest(this.control, bytes, mode);
    } catch (error) {
      this.drain(canContinue);
      this.checkCrash();
      if (this.crash) return false;
      throw error;
    }
    this.requestHangMs =
      new DataView(bytes.buffer, bytes.byteOffset, 2).getUint16(0, true) === requestKinds.get("Init")
        ? (this.options.initHangMs ?? 30000)
        : this.options.hangMs;
    this.inFlight = true;
    this.movedAt = performance.now();
    this.ringWrite = Atomics.load(this.control.words, Word.ringWrite);
    return true;
  }
  private next(): void {
    if (this.inFlight || this.crash) return;
    this.current = this.queue.shift();
    if (!this.current) return;
    if (this.publish(this.current.bytes, ReqMode.async)) this.watch();
  }
  private complete(canContinue?: () => boolean): Reply | undefined {
    if (!this.inFlight || Atomics.load(this.control.words, Word.state) !== State.reply) return;
    const outSeq = Atomics.load(this.control.words, Word.replyOutSeq) >>> 0;
    // Modulo ordering admits output published after the reply and sequence wrap.
    if (outSeq !== 0 && (this.seq - outSeq) >>> 0 >= 0x80000000) return;
    let reply;
    try {
      reply = takeReply(this.control);
    } catch (error) {
      this.drain(canContinue);
      this.checkCrash();
      if (this.crash) return;
      throw error;
    }
    this.inFlight = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    return { ...reply, records: this.through(reply.outSeq) };
  }
  private through(outSeq: number): DecodedLazyRecord[] {
    const after = this.output.findIndex(
      (record) =>
        record.seq !== 0 &&
        (outSeq === 0 || ((record.seq - outSeq) >>> 0 > 0 && (record.seq - outSeq) >>> 0 < 0x80000000)),
    );
    return this.output.splice(0, after < 0 ? this.output.length : after);
  }
  private diagnostic(error: unknown): void {
    const diagnostic = error instanceof ProtocolError ? error : new ProtocolError({ message: String(error) });
    if (this.options.development) throw diagnostic;
    console.error(diagnostic);
  }
  private drain(canContinue?: () => boolean): void {
    if (this.crash) return;
    for (;;) {
      let bytes: Uint8Array | undefined;
      try {
        bytes = this.reader.next(canContinue);
      } catch (error) {
        this.diagnostic(error);
        this.fail({ reason: "host", message: "Invalid ring framing" });
        return;
      }
      if (!bytes) break;
      const header = new DataView(bytes.buffer, bytes.byteOffset);
      const seq = header.getUint32(0, true);
      const expected = (this.seq + 1) >>> 0 || 1;
      if (seq !== 0) this.seq = seq;
      try {
        if (seq !== 0 && seq !== expected)
          throw new ProtocolError({ message: `Expected record sequence ${expected}, received ${seq}` });
        if (seq === 0 && header.getUint32(4, true) !== 0)
          throw new ProtocolError({ message: "Host records must carry ic 0" });
        const decoded = decodeRecordLazy(bytes);
        if (decoded.record._tag === "Crashed") {
          this.fail(crashFromRecord(decoded.record));
          return;
        }
        this.output.push(decoded);
      } catch (error) {
        this.diagnostic(error);
      }
    }
    const write = Atomics.load(this.control.words, Word.ringWrite);
    if (write !== this.ringWrite) {
      this.ringWrite = write;
      this.movedAt = performance.now();
    }
  }
  private checkCrash(): void {
    if (Atomics.load(this.control.words, Word.state) === State.crashed)
      this.fail({ reason: "host", message: "Worker control state is CRASHED" });
  }
  private readonly message = (event: MessageEvent<HostMessage>): void => {
    if (this.crash) return;
    const message = event.data;
    switch (message.type) {
      case "ready":
        this.ready = true;
        this.resolveStart?.();
        this.resolveStart = undefined;
        this.rejectStart = undefined;
        break;
      case "storage":
        this.storage = message.state;
        break;
      case "error":
        this.fail({ reason: "load", message: message.message });
        break;
      case "crashed":
        this.drain();
        this.fail({ reason: "host", message: message.message });
        break;
      case "doorbell":
        this.doorbell();
        break;
    }
  };
  private doorbell(): void {
    clearTimeout(this.deferred);
    this.deferred = undefined;
    if (this.crash) return;
    Atomics.store(this.control.words, Word.doorbell, 0);
    this.drain();
    this.checkCrash();
    if (this.crash) return;
    const reply = this.complete();
    this.checkCrash();
    if (this.crash) return;
    if (reply) {
      const current = this.current;
      this.current = undefined;
      if (current) current.resolve(reply);
      else this.abandoned.push(reply);
    }
    for (const listener of this.doorbells) listener();
    this.next();
  }
  private readonly error = (event: Event): void => {
    this.drain();
    this.fail({ reason: "worker", message: "message" in event ? String(event.message) : "Worker error" });
  };
  private watch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.drain();
      this.checkCrash();
      if (this.crash || !this.inFlight) return;
      if (performance.now() - this.movedAt >= this.requestHangMs)
        this.fail({ reason: "hang", message: "Worker request stopped making progress" });
      else this.watch();
    }, this.requestHangMs);
  }
  private fail(crash: CrashInfo): void {
    if (this.crash) return;
    if (this.storage) crash = { ...crash, storage: this.storage };
    this.crash = crash;
    this.inFlight = false;
    clearTimeout(this.deferred);
    clearTimeout(this.timer);
    this.worker.removeEventListener("message", this.message);
    this.worker.removeEventListener("error", this.error);
    this.worker.removeEventListener("messageerror", this.error);
    this.worker.terminate();
    if (!this.ready) this.rejectStart?.(new Error(crash.message));
    this.current?.reject(crash);
    this.current = undefined;
    for (const pending of this.queue.splice(0)) pending.reject(crash);
    for (const listener of this.crashes) listener(crash);
  }
}
