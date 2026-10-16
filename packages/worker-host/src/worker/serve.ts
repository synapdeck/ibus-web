// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { CrashReason, errorReport } from "@ibus-web/protocol";
import { Effect } from "effect";
import { HostConfig } from "./config.ts";
import { RelayFailed, runtimeIntact, RuntimeStopped, stoppedRecord, within } from "./failure.ts";
import { Instruments, type InstrumentReply } from "./instruments.ts";
import { HostRuntime } from "./layers/runtime.ts";
import { Relay } from "./layers/relay.ts";
import { Storage } from "./layers/storage.ts";
import { PlannedStorage } from "./layers/storage-plan.ts";
import { HostWorker } from "./layers/worker.ts";
import {
  finishReply,
  mailWaiting,
  pump,
  ringDoorbell,
  serveUntilExcursion,
  step,
  topUp,
  type LoopContext,
} from "./loop.ts";
import { drainOutput, HostDefect } from "./output.ts";
import { alloc, loadSides, RuntimeRefused, warmPool } from "./runtime.ts";
import { EngineScopes } from "./scopes.ts";

// The most pumps the host runs to settle the engines it destroys on its way
// out.
const SHUTDOWN_PUMPS = 8;

// Serves requests for good, leaving the synchronous section only to top the
// pool up, to take the page's messages, or for an instrument's reply. Fails
// once the runtime or the relay stops.
export const serve: Effect.Effect<
  void,
  RuntimeStopped | RelayFailed,
  HostWorker | HostRuntime | Relay | Storage | HostConfig | PlannedStorage
> = Effect.gen(function* () {
  const worker = yield* HostWorker;
  const { handle, wakeIndex, buffers } = yield* HostRuntime;
  const relay = yield* Relay;
  const storage = yield* Storage;
  const config = yield* HostConfig;
  const instruments = yield* Instruments;
  const { control } = worker;
  const { module, constants } = yield* PlannedStorage;

  // Runs a runtime call; one that throws marks the host crashed before
  // anything else can happen.
  const guarded = <T>(call: () => T): Effect.Effect<T, RuntimeStopped> =>
    Effect.try({
      try: call,
      catch: (error) => {
        const stopped =
          error instanceof RuntimeStopped
            ? error
            : new RuntimeStopped({ error, reason: error instanceof HostDefect ? CrashReason.host : CrashReason.trap });
        worker.crashed(stoppedRecord(stopped));
        return stopped;
      },
    });

  const scopes = new EngineScopes(buffers.request, constants.canceled);
  let moduleLoaded = false;
  // The page hears of it once.
  let closedReported = false;
  const watchStorage = (): void => {
    if (closedReported || !storage.closed()) return;
    closedReported = true;
    worker.env.post({
      type: "storage",
      state: "closed",
      message: "the IndexedDB connection closed; the engine's storage fails with EIO",
    });
  };

  const outputLength = yield* guarded(() => new Int32Array(handle.bytes.buffer, alloc(handle, 4), 1));
  const ctx: LoopContext = {
    watchStorage,
    handle,
    control,
    constants,
    wakeIndex,
    buffers,
    instruments,
    lowWater: constants.poolLowWater,
    writer: worker.writer,
    scopes,
    loadEngine: () => {
      if (moduleLoaded) return;
      try {
        loadSides(handle, [{ name: "engine", bytes: module }]);
      } catch (error) {
        // A refused load leaves the runtime fit to call, so its account of
        // the failure reaches the page ahead of the Crashed record.
        if (error instanceof RuntimeRefused)
          try {
            drainOutput(handle.rt, worker.writer, outputLength, ctx);
          } catch {
            // The crash is already LOAD's; a failed drain only loses records.
          }
        throw new RuntimeStopped({ error, reason: CrashReason.load });
      }
      moduleLoaded = true;
      instruments.warm(() => warmPool(handle));
    },
    outputLength,
    postDoorbell: () => worker.env.post({ type: "doorbell" }),
    lastSeq: 0,
    topUpFailed: false,
    stopping: false,
    woken: false,
    mailTaken: 0,
  };

  // Destroying the engines left open runs their finalizers, which can leave
  // work for the default context; a few pumps run it without chasing a
  // source that keeps itself due. Records written here belong to no request,
  // so the page hears of them through a doorbell.
  yield* Effect.addFinalizer((exit) =>
    guarded(() => {
      const intact = runtimeIntact(exit);
      try {
        scopes.closeAll(handle.rt, intact);
      } catch (error) {
        if (error instanceof RuntimeStopped && error.reason === CrashReason.fault)
          try {
            drainOutput(handle.rt, worker.writer, outputLength, ctx);
          } catch {
            // The crash is already the fault's; a failed drain only loses records.
          }
        throw error;
      }

      if (!intact) return;
      for (let round = 0; round < SHUTDOWN_PUMPS; round++) if (pump(handle.rt, constants) !== 0) break;
      if (drainOutput(handle.rt, worker.writer, outputLength, ctx) > 0) ringDoorbell(ctx);
    }).pipe(Effect.orDie),
  );

  const relayFailed = Effect.gen(function* () {
    const message = yield* Effect.promise(() => within(relay.failed, config.crashWaitMs, "stopped without an error"));
    return yield* new RelayFailed({ message });
  });
  const answer = (reply: Promise<InstrumentReply>) =>
    Effect.promise(() => reply).pipe(Effect.flatMap((value) => guarded(() => finishReply(ctx, value))));

  // Serves and pumps from the event loop as the host would asleep, waiting
  // for requests with Atomics.waitAsync() raced against settled, until done
  // says the excursion's work has finished, or the host stops.
  const serveUntil = (settled: Promise<unknown>, done: () => boolean) =>
    Effect.gen(function* () {
      while (!done()) {
        const next = yield* guarded(() => step(ctx));
        if (next.kind === "served") continue;
        if (next.kind === "await") {
          yield* answer(next.reply);
          continue;
        }
        if (next.kind === "stopped") return "stopped" as const;
        if (next.kind === "relayFailed") return yield* relayFailed;

        const woke = Atomics.waitAsync(
          handle.words,
          wakeIndex,
          next.seen,
          next.delay < 0 ? Infinity : next.delay,
        ).value;
        const value =
          typeof woke === "string" ? woke : yield* Effect.promise(() => Promise.race([woke, settled.then(() => "")]));
        ctx.woken = value === "ok";
      }
      return "done" as const;
    });

  // The new Workers load only while this thread's event loop runs.
  const topUpPool = (want: number) =>
    Effect.gen(function* () {
      instruments.eventLoopTurn();
      let outcome: { ms: number; createMs: number } | { error: unknown } | undefined;
      const loaded = topUp(handle.rt, want, config.topUpLimitMs).then(
        (done) => {
          outcome = done;
        },
        (error: unknown) => {
          outcome = { error };
        },
      );

      if ((yield* serveUntil(loaded, () => outcome !== undefined)) === "stopped") return;
      if (outcome === undefined) return;
      if ("error" in outcome) {
        ctx.topUpFailed = true;
        yield* Effect.logError(errorReport(outcome.error));
      } else {
        instruments.toppedUp(want, outcome.ms, outcome.createMs);
        yield* guarded(() => instruments.warm(() => warmPool(handle)));
      }
    });

  // The page's messages arrive only through the event loop. The host takes
  // each as it arrives, as many as the mail word counts, and prepares its
  // engine at once, beside any other prepare still running, while it serves
  // requests as it would asleep; it goes back to its synchronous section
  // once every prepare has ended and no message is waiting. A call into the
  // runtime that threw while installing stops the host.
  const takeMail = Effect.gen(function* () {
    instruments.eventLoopTurn();
    let outcome: { error: unknown } | "done" | undefined;
    const taking = (async () => {
      const running = new Set<Promise<void>>();
      while (mailWaiting(ctx) || running.size > 0) {
        if (mailWaiting(ctx) && worker.mail.waiting) {
          const message = await worker.mail.next();
          ctx.mailTaken = (ctx.mailTaken + 1) | 0;
          if (message === undefined) continue;
          const preparing: Promise<void> = storage.prepare(message.engine).finally(() => running.delete(preparing));
          running.add(preparing);
        } else await Promise.race([...running, worker.mail.arrival()]);
      }
    })().then(
      () => {
        outcome = "done";
      },
      (error: unknown) => {
        outcome = { error };
      },
    );

    if ((yield* serveUntil(taking, () => outcome !== undefined)) === "stopped") return;
    const failed = outcome;
    if (failed !== undefined && failed !== "done")
      yield* guarded(() => {
        throw failed.error;
      });
  });

  for (;;) {
    const excursion = yield* guarded(() => serveUntilExcursion(ctx));
    switch (excursion.kind) {
      case "stopped":
        return;
      case "topUp":
        yield* topUpPool(excursion.want);
        break;
      case "mail":
        yield* takeMail;
        break;
      case "await":
        yield* answer(excursion.reply);
        break;
      case "relayFailed":
        return yield* relayFailed;
    }
  }
}).pipe(Effect.scoped);
