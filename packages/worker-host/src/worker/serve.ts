// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { CrashReason, errorReport } from "@ibus-web/protocol";
import { Effect } from "effect";
import type { Backend, Pool } from "./backend.ts";
import { HostConfig } from "./config.ts";
import { RelayFailed, runtimeIntact, RuntimeStopped, stoppedRecord, within } from "./failure.ts";
import { Instruments, type InstrumentReply } from "./instruments.ts";
import { HostWorker } from "./layers/worker.ts";
import { finishReply, mailWaiting, ringDoorbell, serveUntilExcursion, step, type LoopContext } from "./loop.ts";
import { HostDefect, type OutputRing } from "./output.ts";
import { storageWatcher, type WatchedStorage } from "./storage/watch.ts";

// The most pumps the host runs to settle the engines it destroys on its way
// out.
const SHUTDOWN_PUMPS = 8;

// What the loop serves a module through.
export interface Serving {
  // Makes the backend, where a throw stops the host.
  readonly backend: (ring: OutputRing) => Backend;
  readonly storage: WatchedStorage & {
    // Installs an engine's own data before it is first made, then posts
    // "prepared".
    readonly prepare: (engine: string) => Promise<void>;
  };
  // Settles with the relay's error, which this thread hears only in its
  // event loop.
  readonly relayFailed: Promise<string>;
}

// Serves requests for good, leaving the synchronous section only to top the
// pool up, to take the page's messages, or for an instrument's reply. Fails
// once the module or the relay stops.
export const serve = ({
  backend: makeBackend,
  storage,
  relayFailed: relayError,
}: Serving): Effect.Effect<void, RuntimeStopped | RelayFailed, HostWorker | HostConfig> =>
  Effect.gen(function* () {
    const worker = yield* HostWorker;
    const config = yield* HostConfig;
    const instruments = yield* Instruments;
    const { control } = worker;

    // Runs a call into the backend; one that throws marks the host crashed
    // before anything else can happen.
    const guarded = <T>(call: () => T): Effect.Effect<T, RuntimeStopped> =>
      Effect.try({
        try: call,
        catch: (error) => {
          const stopped =
            error instanceof RuntimeStopped
              ? error
              : new RuntimeStopped({
                  error,
                  reason: error instanceof HostDefect ? CrashReason.host : CrashReason.trap,
                });
          worker.crashed(stoppedRecord(stopped));
          return stopped;
        },
      });

    const watchStorage = storageWatcher(storage, worker.env.post);
    const ring: OutputRing = {
      writer: worker.writer,
      control,
      postDoorbell: () => worker.env.post({ type: "doorbell" }),
      lastSeq: 0,
    };
    const backend = yield* guarded(() => makeBackend(ring));
    const { wake } = backend;
    const ctx: LoopContext = {
      watchStorage,
      backend,
      control,
      instruments,
      ring,
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
          backend.close(intact);
        } catch (error) {
          if (error instanceof RuntimeStopped && error.reason === CrashReason.fault)
            try {
              backend.drain();
            } catch {
              // The crash is already the fault's; a failed drain only loses records.
            }
          throw error;
        }

        if (!intact) return;
        for (let round = 0; round < SHUTDOWN_PUMPS; round++) if (backend.pump() !== 0) break;
        if (backend.drain() > 0) ringDoorbell(ctx);
      }).pipe(Effect.orDie),
    );

    const relayFailed = Effect.gen(function* () {
      const message = yield* Effect.promise(() => within(relayError, config.crashWaitMs, "stopped without an error"));
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
            wake.words,
            wake.index,
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
    const topUpPool = (pool: Pool, want: number) =>
      Effect.gen(function* () {
        instruments.eventLoopTurn();
        let outcome: { ms: number; createMs: number } | { error: unknown } | undefined;
        const loaded = pool.topUp(want, config.topUpLimitMs).then(
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
          yield* guarded(() => instruments.warm(pool.warm));
        }
      });

    // Waits, as the host serves meanwhile, until a backend's connection has
    // closed, or for closeWaitMs, and reports it.
    const closing = async (): Promise<void> => {
      const deadline = performance.now() + config.closeWaitMs;
      while (!storage.closed() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      watchStorage();
    };

    // The page's messages arrive only through the event loop. The host takes
    // each as it arrives, as many as the mail word counts, and prepares its
    // engine, or checks its storage, at once, beside any other such work still
    // running, while it serves requests as it would asleep; it goes back to its
    // synchronous section once all of it has ended and no message is waiting.
    // A call into the runtime that threw while installing stops the host.
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
            const work: Promise<void> = (
              message.type === "prepare-engine" ? storage.prepare(message.engine) : closing()
            ).finally(() => running.delete(work));
            running.add(work);
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
          yield* topUpPool(excursion.pool, excursion.want);
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
