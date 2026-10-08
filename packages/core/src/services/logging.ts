// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Context, Effect, Layer, PubSub, Stream } from "effect";
import type { Log, PanelEvent } from "@ibus-web/protocol";

/** Waking a service is deferred so an enqueue cannot run its fiber on the key stack. */
export class SyncMailbox<A> {
  private readonly items: A[] = [];
  private closed = false;
  get isClosed(): boolean {
    return this.closed;
  }
  close(): void {
    this.closed = true;
    this.items.length = 0;
    this.wake = undefined;
  }

  private wake: (() => void) | undefined;

  enqueue(value: A): void {
    if (this.closed) return;
    this.items.push(value);
    if (this.wake) queueMicrotask(() => this.wake?.());
  }

  readonly take = Effect.callback<A>((resume) => {
    const take = () => {
      if (this.items.length === 0) return;
      this.wake = undefined;
      resume(Effect.succeed(this.items.shift()!));
    };

    this.wake = take;
    take();

    return Effect.sync(() => {
      if (this.wake === take) this.wake = undefined;
    });
  });
}

export function glibLevel(level: number): "Error" | "Warn" | "Info" | "Debug" {
  if (level & (4 | 8)) return "Error";
  if (level & 16) return "Warn";
  if (level & (32 | 64)) return "Info";
  return "Debug";
}

export interface LogLine {
  readonly module: string;
  readonly ic: number;
  readonly record: Log;
}

export class Logger extends Context.Service<Logger, { enqueue(line: LogLine): void }>()("@ibus-web/core/Logger") {
  static readonly Default = Layer.effect(
    Logger,
    Effect.gen(function* () {
      const mailbox = new SyncMailbox<LogLine>();
      yield* Effect.addFinalizer(() => Effect.sync(() => mailbox.close()));
      yield* mailbox.take.pipe(
        Effect.flatMap(({ module, ic, record }) =>
          Effect.logWithLevel(glibLevel(record.level))(record.message).pipe(
            Effect.annotateLogs({ module, inputContext: ic, domain: record.domain }),
          ),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      return { enqueue: (line: LogLine) => mailbox.enqueue(line) };
    }),
  );
}

export class PanelEvents extends Context.Service<
  PanelEvents,
  {
    readonly events: Stream.Stream<PanelEvent>;
    enqueue(event: PanelEvent): void;
  }
>()("@ibus-web/core/PanelEvents") {
  static readonly Default = Layer.effect(
    PanelEvents,
    Effect.gen(function* () {
      const mailbox = new SyncMailbox<PanelEvent>();
      yield* Effect.addFinalizer(() => Effect.sync(() => mailbox.close()));
      const pubsub = yield* PubSub.unbounded<PanelEvent>();
      yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));
      yield* mailbox.take.pipe(
        Effect.flatMap((event) => PubSub.publish(pubsub, event)),
        Effect.forever,
        Effect.forkScoped,
      );
      return { events: Stream.fromPubSub(pubsub), enqueue: (event: PanelEvent) => mailbox.enqueue(event) };
    }),
  );
}
