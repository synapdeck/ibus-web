// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The Worker scope: the control buffer, the host's channel to the page, its
// logger, and how it reports a failed start or a crash.

import { encodeValue, errorReport } from "@ibus-web/protocol";
import { RingWriter, transportLayout, Word } from "@ibus-web/protocol/transport";
import { Cause, Context, Effect, Exit, Layer, Logger } from "effect";
import { controlViews, postCrash, type ControlViews } from "../../shared/control.ts";
import type { HostInit, HostMessage } from "../../shared/messages.ts";
import { HostConfig } from "../config.ts";
import { crashMessage, crashRecord, startupMessage, type CrashRecord } from "../failure.ts";
import { writeHostRecord } from "../output.ts";

// What a Worker's error event carries, as far as the host reads it.
export interface UncaughtError {
  error?: unknown;
  message?: string;
  preventDefault(): void;
}

// What the host needs of the Worker it runs in.
export interface WorkerEnv {
  post(message: HostMessage): void;
  // Calls listener with each uncaught error this thread's event loop
  // delivers.
  onUncaughtError(listener: (event: UncaughtError) => void): void;
  // The relay's script.
  relayUrl: URL;
}

// The Worker scope: the control buffer, and the host's channel to the page.
export interface HostWorkerShape {
  readonly init: HostInit<WebAssembly.Module, unknown>;
  readonly control: ControlViews;
  readonly writer: RingWriter;
  readonly env: WorkerEnv;
  // Posts "ready"; from here on, a failure is a crash, not a failed start.
  readonly ready: () => void;
  // Writes the Crashed record, if the ring has room, then CRASHED, so the
  // page stops waiting and a drain once it sees CRASHED finds the record;
  // then starts keeping the next uncaught error as the cause. Only the first
  // call does anything.
  readonly crashed: (record: CrashRecord) => void;
}

export class HostWorker extends Context.Service<HostWorker, HostWorkerShape>()("@ibus-web/worker-host/HostWorker") {}

const hostLogger = (writer: RingWriter, control: ControlViews, notify: () => void): Logger.Logger<unknown, void> =>
  Logger.make(({ logLevel, message, cause }) => {
    const parts = Array.isArray(message) ? message : [message];
    const text = parts.map((part) => (typeof part === "string" ? part : errorReport(part))).join(" ");
    const levels = { All: 128, Fatal: 4, Error: 8, Warn: 16, Info: 64, Debug: 128, Trace: 128, None: 0 };

    const payload = encodeValue("(uss)", {
      _tag: "()",
      items: [
        { _tag: "u", value: levels[logLevel] },
        { _tag: "s", value: "worker-host" },
        { _tag: "s", value: cause.reasons.length === 0 ? text : `${text}\n${Cause.pretty(cause)}` },
      ],
    });
    if (writeHostRecord(writer, control, 33, payload)) notify();
  });

// Acquires the control buffer's views and, released with a failure, reports
// it: before "ready" as a failed start, after it as a crash, CRASHED written
// first.
export const workerLayer = (
  init: HostInit<WebAssembly.Module, unknown>,
  env: WorkerEnv,
): Layer.Layer<HostWorker, never, HostConfig> => {
  const layout = init.layout ?? transportLayout();
  const control = controlViews(init.control, layout);
  const writer = new RingWriter(control, layout);
  const notify = (): void => {
    if (Atomics.exchange(control.words, Word.doorbell, 1) === 0) env.post({ type: "doorbell" });
  };

  return Layer.effect(
    HostWorker,
    Effect.gen(function* () {
      const config = yield* HostConfig;
      const startedAt = performance.now();
      let isReady = false;
      let isCrashed = false;

      let keepError: (why: string) => void = () => {};
      const threadError = new Promise<string>((resolve) => {
        keepError = resolve;
      });
      // Registered now rather than once the host stops: the thread's error
      // may already be queued by then.
      env.onUncaughtError((event) => {
        if (!isCrashed) return;
        event.preventDefault();
        keepError(errorReport(event.error ?? event.message));
      });

      const crashed = ({ reason, message }: CrashRecord): void => {
        if (isCrashed) return;
        isCrashed = true;
        writeHostRecord(
          writer,
          control,
          34,
          encodeValue("(us)", {
            _tag: "()",
            items: [
              { _tag: "u", value: reason },
              { _tag: "s", value: message },
            ],
          }),
        );
        postCrash(control);
      };

      yield* Effect.addFinalizer((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : isReady
            ? Effect.promise(async () => {
                crashed(crashRecord(exit.cause));
                const message = await crashMessage(exit.cause, threadError, config.crashWaitMs);
                env.post({ type: "crashed", message });
              })
            : Effect.sync(() => env.post({ type: "error", message: startupMessage(exit.cause) })),
      );

      return {
        init,
        control,
        writer,
        env,
        ready: () => {
          isReady = true;
          env.post({ type: "ready", startupMs: performance.now() - startedAt });
        },
        crashed,
      };
    }),
  ).pipe(Layer.provideMerge(Logger.layer([hostLogger(writer, control, notify)])));
};
