// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Context, Effect, Exit, Layer, PubSub, Scope, Stream } from "effect";
import {
  asError,
  CreateEngine,
  DestroyEngine,
  Disable,
  Enable,
  FocusIn,
  FocusOut,
  Reset,
  SetCapabilities,
  SetContentType,
  IBusCapability as Cap,
  type EngineDescriptor,
  type PanelEvent,
  type Request,
} from "@ibus-web/protocol";
import { ModuleRegistry, PrepareEngineError } from "../services/modules.ts";
import { CoreConfig } from "../services/config.ts";
import { PanelEvents, SyncMailbox } from "../services/logging.ts";
import type { AsyncKeyResult, SurfaceAdapter } from "./replay.ts";
import { InputContext } from "./contexts.ts";
import type { Reply } from "../connection/connection.ts";

export interface HotkeyRegistry {
  add(predicate: (event: KeyboardEvent) => boolean, action: () => void): () => void;
}

export interface AttachOptions {
  /** sync preserves native passthrough; async owns fallback; manual leaves keyboard capture to the editor. */
  readonly keyMode?: "sync" | "async" | "manual";
}

export interface Selection {
  readonly module: string;
  readonly engine: string;
}

export interface RouterService {
  attach(adapter: SurfaceAdapter, options?: AttachOptions): () => void;
  /**
   * Call during the original event dispatch. Accepted keys are prevented immediately;
   * excluded keys retain native handling. The router applies fallback before returning
   * `replayed`; callers must not prevent excluded events or replay the result again.
   * Detach/disposal cancels pending ownership. Adapter callback failures reject.
   */
  keyAsync(adapter: SurfaceAdapter, event: KeyboardEvent): Promise<AsyncKeyResult>;
  /** Without an engine, selects the module's first. An unknown module or engine fails before anything changes. */
  select(module: string, engine?: string): Effect.Effect<void, Error>;
  /** Returns every surface, overrides included, to plain browser input; Workers stay loaded. */
  deselect(): Effect.Effect<void, Error>;
  unload(module: string): Effect.Effect<void, Error>;
  activeContext(): { module: string; engine: string; ic: number; adapter: SurfaceAdapter } | undefined;
  /** Without an engine, the module's first; `undefined` returns the surface to the page's selection. */
  override(
    adapter: SurfaceAdapter,
    selection: { readonly module: string; readonly engine?: string } | undefined,
  ): Effect.Effect<void, Error>;
  readonly selection: Selection | undefined;
  readonly selectionChanges: Stream.Stream<Selection | undefined>;
  readonly hotkeys: HotkeyRegistry;
  readonly panel: Stream.Stream<PanelEvent>;
}

/** A surface's engine failed to start; `reason` is the engine's own explanation, when it gave one. */
export class CreateEngineError extends Error {
  readonly _tag = "CreateEngineError";
  readonly module: string;
  readonly engine: string;
  readonly reason: string | undefined;

  constructor(module: string, engine: string, ret: number, reason: string | undefined) {
    super(`Engine ${engine} of module ${module} could not be created: ${reason ?? `CreateEngine returned ${ret}`}`);
    this.module = module;
    this.engine = engine;
    this.reason = reason;
  }
}

// An engine that failed to start, its data or itself: the selection stands, and the surface stays on native input.
const engineFailed = (error: Error): error is CreateEngineError | PrepareEngineError =>
  error instanceof CreateEngineError || error instanceof PrepareEngineError;

export class Router extends Context.Service<Router, RouterService>()("@ibus-web/core/Router") {
  static readonly Default = Layer.effect(
    Router,
    Effect.suspend(() => makeRouter),
  );
}

interface Surface {
  readonly adapter: SurfaceAdapter;
  readonly ic: number;
  /** By module: the host holds one engine per input context, so a module's engines take turns in one. */
  readonly contexts: Map<string, InputContext>;
  attached: boolean;
  focused: boolean;
  suspended: boolean;
  /** Overrides waiting on a manifest read; until they apply, the surface wants no context. */
  reading: number;
  /** Counts override changes, so one that had to wait for a manifest applies only if none came after it. */
  overrides: number;
  override: Selection | undefined;
  active: InputContext | undefined;
  cleanup: () => void;
}

interface PendingReset {
  readonly context: InputContext;
  readonly generation: number;
  reserve(): void;
  release(): void;
}

const same = (a: Selection | undefined, b: Selection | undefined) => a?.module === b?.module && a?.engine === b?.engine;

export const makeRouter = Effect.gen(function* () {
  const registry = yield* ModuleRegistry;
  const config = yield* CoreConfig;
  const panel = yield* PanelEvents;
  const scope = yield* Scope.Scope;
  const surfaces = new Map<SurfaceAdapter, Surface>();
  // Unload bypasses the mailbox, so queued selections must retain their original lifetime.
  const selectionEpochs = new Map<string, number>();
  const hotkeys = new Set<{ predicate: (event: KeyboardEvent) => boolean; action: () => void }>();
  const mailbox = new SyncMailbox<() => Effect.Effect<void, Error>>();
  // A selection whose module's manifest hasn't been read yet waits for the read in the mailbox. Until then,
  // surfaces following the page want no context, so output for a context it replaces is dropped at once.
  // `selections` counts selection changes, so a waiting one applies only if none came after it.
  let selected: Selection | undefined,
    reading = 0,
    selections = 0,
    nextIc = 1,
    closed = false;

  const changes = new SyncMailbox<Selection | undefined>();
  const pubsub = yield* PubSub.unbounded<Selection | undefined>();
  yield* Effect.addFinalizer(() => Effect.sync(() => changes.close()));
  yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));
  yield* changes.take.pipe(
    Effect.flatMap((selection) => PubSub.publish(pubsub, selection)),
    Effect.forever,
    Effect.forkScoped,
  );
  const choose = (selection: Selection | undefined) => {
    if (same(selected, selection)) return;
    selected = selection;
    changes.enqueue(selection);
  };
  const apply = (selection: Selection | undefined) => {
    if (!same(selected, selection))
      for (const surface of surfaces.values()) if (surface.override === undefined) surface.suspended = true;
    choose(selection);
  };
  const setOverride = (surface: Surface, selection: Selection | undefined) => {
    if (same(surface.override, selection)) return;
    surface.override = selection;
    surface.suspended = true;
  };

  const desired = (surface: Surface) =>
    surface.reading > 0 ? undefined : (surface.override ?? (reading > 0 ? undefined : selected));
  const wants = (surface: Surface, target: Selection) =>
    !closed &&
    surface.attached &&
    surface.focused &&
    !surface.adapter.contentType().disabled &&
    same(desired(surface), target);
  const pick = (engines: readonly EngineDescriptor[], module: string, engine: string | undefined) => {
    const name = engine ?? engines[0]!.name;
    return engines.some((descriptor) => descriptor.name === name)
      ? ({ module, engine: name } satisfies Selection)
      : new Error(`Unknown engine: ${name} in module ${module}`);
  };
  const resolve = (module: string, engine: string | undefined) =>
    registry.engines(module).pipe(
      Effect.flatMap((engines) => {
        const target = pick(engines, module, engine);
        return target instanceof Error ? Effect.fail(target) : Effect.succeed(target);
      }),
    );

  const live = (context: InputContext) =>
    registry.snapshot(context.module)?.generation === context.generation &&
    !!registry.snapshot(context.module)?.connection;
  const request = (context: InputContext, message: Request) =>
    Effect.tryPromise({ try: () => registry.request(context.module, message, context.ic), catch: asError });
  const refresh = (surface: Surface, context: InputContext) =>
    Effect.gen(function* () {
      if (!wants(surface, context) || !context.created || !context.focused || !live(context)) return;
      for (const message of context.updates(config.surroundingWindow)) {
        if (!wants(surface, context) || !live(context)) return;
        yield* request(context, message);
      }
    });
  const drain = (context: InputContext) =>
    Effect.tryPromise({ try: () => registry.drainContext(context.module, context), catch: asError });
  const pendingSubmissions = new Set<() => void>();
  const pendingRefresh = new Set<InputContext>();
  const pendingResets = new Set<PendingReset>();
  const enqueueRefresh = (surface: Surface, context: InputContext) => {
    if (pendingRefresh.has(context) || closed) return;
    pendingRefresh.add(context);
    mailbox.enqueue(() =>
      Effect.gen(function* () {
        pendingRefresh.delete(context);
        yield* refresh(surface, context);
      }),
    );
  };
  const finish = (surface: Surface) => {
    if (surface.active) {
      surface.active.ready = false;
      surface.active.finish();
    }
  };

  // Another engine of the module takes over the surface's input context, so the old one is destroyed first.
  const replace = (surface: Surface, context: InputContext) =>
    Effect.gen(function* () {
      surface.contexts.delete(context.module);
      context.unregister();
      if (context.created && live(context)) yield* request(context, new DestroyEngine({}));
      context.invalidate();
    });

  const createFailure = (context: InputContext, reply: Reply) => {
    const reason = reply.records.flatMap(({ ic, record }) =>
      ic === context.ic && record._tag === "CreateEngineFailed" ? [record.message] : [],
    )[0];
    return new CreateEngineError(context.module, context.engine, reply.ret, reason);
  };

  const reconcile = (surface: Surface) =>
    Effect.gen(function* () {
      const target = desired(surface),
        old = surface.active;

      if (old && !wants(surface, old)) {
        const switching = !same(target, old);
        surface.suspended = true;
        yield* drain(old);
        old.finish();
        old.ready = false;
        old.acceptOutput = false;
        if (live(old) && old.created) {
          if (switching && old.enabled) {
            old.enabled = false;
            yield* request(old, new Disable({}));
          }
          if (old.focused) {
            old.focused = false;
            yield* request(old, new FocusOut({}));
          }
        }
        panel.enqueue({ _tag: "hide", module: old.module, ic: old.ic });
        if (switching) surface.active = undefined;
      }

      if (target === undefined || !wants(surface, target)) return;
      yield* registry.ensure(target.module);
      if (!wants(surface, target)) return;

      const existing = surface.contexts.get(target.module);
      if (existing && existing.engine !== target.engine) {
        yield* replace(surface, existing);
        if (!wants(surface, target)) return;
      }

      const snapshot = registry.snapshot(target.module)!;
      let context = surface.contexts.get(target.module);
      if (!context) {
        const created = new InputContext({
          ic: surface.ic,
          module: target.module,
          engine: target.engine,
          generation: snapshot.generation,
          adapter: surface.adapter,
          current: () =>
            surface.attached &&
            live(created) &&
            (created.created ? created.acceptOutput : wants(surface, created) && surface.active === created),
          refresh: () => enqueueRefresh(surface, created),
          panel: (event) => panel.enqueue(event),
        });
        context = created;
        surface.contexts.set(target.module, context);
        context.unregister = registry.registerContext(target.module, context);
      }
      surface.active = context;
      if (context.generation !== snapshot.generation) {
        context.invalidate();
        context.generation = snapshot.generation;
      }
      const generation = context.generation;
      const current = () => wants(surface, target) && live(context) && generation === context.generation;

      if (!context.created) {
        // The surface stays on native input while the engine's own data
        // installs, and the mailbox goes on; the install's end comes back
        // through it.
        if (!registry.isPrepared(target.module, target.engine)) {
          yield* download(target);
          return;
        }
        const reply = yield* request(context, new CreateEngine({ name: context.engine }));
        if (generation !== registry.snapshot(target.module)?.generation) return;
        if (reply.ret < 0) return yield* Effect.fail(createFailure(context, reply));
        context.created = true;
      }
      if (!current()) return;
      context.acceptOutput = true;

      if (!context.focused) {
        const capabilities = surface.adapter.capabilities();
        yield* request(
          context,
          new SetCapabilities({
            capabilities:
              Cap.FOCUS |
              Cap.PROPERTY |
              (capabilities.preedit ? Cap.PREEDIT_TEXT : 0) |
              (capabilities.auxText ? Cap.AUXILIARY_TEXT : 0) |
              (capabilities.lookupTable ? Cap.LOOKUP_TABLE : 0) |
              (capabilities.surroundingText && surface.adapter.surrounding(config.surroundingWindow) !== undefined
                ? Cap.SURROUNDING_TEXT
                : 0),
          }),
        );
        if (!current()) return;
        const { purpose, hints } = surface.adapter.contentType();
        yield* request(context, new SetContentType({ purpose, hints }));
        if (!current()) return;
        if (!context.enabled) {
          yield* request(context, new Enable({}));
          context.enabled = true;
        }
        if (!current()) return;
        yield* request(context, new FocusIn({}));
        context.focused = true;
        if (!current()) return;
      }

      // Earlier blur owners have drained. Reserve deferred resets before this
      // context accepts keys that could otherwise overtake them during refresh.
      for (const pending of pendingResets)
        if (pending.context === context && pending.generation === generation) pending.reserve();
      context.ready = true;
      surface.suspended = false;
      yield* refresh(surface, context);
    });

  // One surface's engine failing to start mustn't leave the others on the old selection.
  const reconcileAll = (which: (surface: Surface) => boolean = () => true) =>
    Effect.gen(function* () {
      const failures: (CreateEngineError | PrepareEngineError)[] = [];
      for (const surface of [...surfaces.values()].filter(which))
        yield* reconcile(surface).pipe(
          Effect.catch((error) =>
            engineFailed(error) ? Effect.sync(() => void failures.push(error)) : Effect.fail(error),
          ),
        );

      if (failures.length > 0) return yield* Effect.fail(failures[0]!);
    });

  // Engines whose own data installs in the background, by module and engine. Once it ends, the surfaces that still
  // want the engine make it; a surface that has moved on leaves it installed. A failure reaches the mailbox's log only
  // if a surface still wants the engine, and its next focus tries again.
  const downloads = new Set<string>();
  const download = (target: Selection) =>
    Effect.suspend(() => {
      const key = `${target.module}\0${target.engine}`;
      if (downloads.has(key)) return Effect.void;
      downloads.add(key);
      return registry.prepare(target.module, target.engine).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            downloads.delete(key);
            if (closed) return;
            mailbox.enqueue(() =>
              Exit.isSuccess(exit)
                ? reconcileAll((surface) => wants(surface, target))
                : [...surfaces.values()].some((surface) => wants(surface, target))
                  ? exit
                  : Effect.void,
            );
          }),
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    });

  const submit = (work: () => Effect.Effect<void, Error>): Effect.Effect<void, Error> =>
    Effect.callback((resume) => {
      const cancel = () => resume(Effect.fail(new Error("Router is closed")));
      if (closed) {
        cancel();
        return;
      }
      pendingSubmissions.add(cancel);
      mailbox.enqueue(() =>
        work().pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.sync(() => {
                pendingSubmissions.delete(cancel);
                resume(Effect.fail(error));
              }),
            onSuccess: () =>
              Effect.sync(() => {
                pendingSubmissions.delete(cancel);
                resume(Effect.void);
              }),
          }),
        ),
      );
      return Effect.sync(() => {
        pendingSubmissions.delete(cancel);
      });
    });
  yield* mailbox.take.pipe(
    Effect.flatMap((work) => Effect.suspend(work).pipe(Effect.catch((error) => Effect.logWarning(error)))),
    Effect.forever,
    Effect.forkScoped,
  );

  // Holds a read-waiting change's count until it applies or fails; the returned release is idempotent.
  const hold = (count: { increment(): void; decrement(): void }) => {
    let held = true;
    count.increment();
    return () => {
      if (!held) return;
      held = false;
      count.decrement();
    };
  };
  // A change that fails leaves the selection as it was, and the surfaces it suspended return to it. An engine that
  // failed to start is the exception: the change has applied and the selection stands, and the surfaces wanting the
  // engine stay on native input until their next focus tries again.
  const restore = (release: () => void, error: Error) =>
    Effect.gen(function* () {
      release();
      if (!engineFailed(error)) for (const surface of surfaces.values()) yield* Effect.ignore(reconcile(surface));
      return yield* Effect.fail(error);
    });

  const attempt = (errors: unknown[], work: () => void) => {
    try {
      work();
    } catch (error) {
      errors.push(error);
    }
  };
  const detachSurface = (surface: Surface): unknown[] => {
    if (!surface.attached) return [];
    const errors: unknown[] = [];
    surface.attached = false;
    surface.focused = false;
    attempt(errors, surface.cleanup);
    attempt(errors, () => finish(surface));
    surfaces.delete(surface.adapter);
    for (const context of surface.contexts.values()) attempt(errors, context.unregister);
    mailbox.enqueue(() =>
      Effect.gen(function* () {
        for (const context of surface.contexts.values())
          if (context.created && live(context)) {
            if (context.focused) {
              context.focused = false;
              yield* request(context, new FocusOut({}));
            }
            yield* request(context, new DestroyEngine({}));
            context.invalidate();
            panel.enqueue({ _tag: "hide", module: context.module, ic: context.ic });
          }
      }),
    );
    return errors;
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      mailbox.close();
      pendingRefresh.clear();
      hotkeys.clear();
      for (const cancel of pendingSubmissions) cancel();
      pendingSubmissions.clear();
      const errors: unknown[] = [];
      for (const surface of surfaces.values()) errors.push(...detachSurface(surface));
      surfaces.clear();
      for (const pending of pendingResets) attempt(errors, pending.release);
      pendingResets.clear();
      if (errors.length) throw new AggregateError(errors, "Surface teardown failed");
    }),
  );

  const service: RouterService = {
    panel: panel.events,
    get selection() {
      return selected;
    },
    selectionChanges: Stream.fromPubSub(pubsub),
    activeContext: () => {
      for (const surface of surfaces.values()) {
        const context = surface.active;
        if (context && surface.focused && surface.attached && context.ready && wants(surface, context))
          return { module: context.module, engine: context.engine, ic: context.ic, adapter: surface.adapter };
      }
      return undefined;
    },
    unload: (module) =>
      Effect.suspend(() => {
        if (closed) return Effect.fail(new Error("Router is closed"));
        if (!registry.snapshot(module)) return Effect.fail(new Error(`Unknown module: ${module}`));
        selectionEpochs.set(module, (selectionEpochs.get(module) ?? 0) + 1);
        const errors: unknown[] = [];
        if (selected?.module === module) choose(undefined);
        for (const surface of surfaces.values()) {
          if (surface.override?.module === module) surface.override = undefined;
          const context = surface.contexts.get(module);
          if (!context) continue;
          context.unregister();
          context.invalidate();
          surface.contexts.delete(module);
          if (surface.active === context) {
            surface.active = undefined;
            attempt(errors, () => surface.adapter.setPreedit(undefined));
          }
          panel.enqueue({ _tag: "hide", module, ic: context.ic });
        }
        return registry
          .unload(module)
          .pipe(
            Effect.andThen(() =>
              errors.length ? Effect.fail(new AggregateError(errors, "Module surface teardown failed")) : Effect.void,
            ),
          );
      }),
    hotkeys: {
      add: (predicate, action) => {
        const entry = { predicate, action };
        if (!closed) hotkeys.add(entry);
        return () => {
          hotkeys.delete(entry);
        };
      },
    },
    select: (module, engine) =>
      Effect.suspend(() => {
        if (closed) return Effect.fail(new Error("Router is closed"));
        const snapshot = registry.snapshot(module);
        if (!snapshot) return Effect.fail(new Error(`Unknown module: ${module}`));

        const epoch = selectionEpochs.get(module) ?? 0;
        const cancelled = () => epoch !== (selectionEpochs.get(module) ?? 0);
        const cancellation = () => Effect.fail(new Error(`Selection of ${module} was cancelled by unload`));
        const start = Effect.gen(function* () {
          yield* registry.ensure(module);
          if (cancelled()) return yield* cancellation();
          yield* reconcileAll();
        });
        // The engine's own data installs outside the mailbox, focused surface or not, so that it is there by the
        // time one is; the selection then waits for it, and has the surfaces that still want the engine make it. A
        // selection superseded meanwhile resolves, the data staying installed.
        const settle = (target: Selection) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(registry.prepare(target.module, target.engine));
            if (!same(selected, target) || cancelled()) return;
            if (Exit.isFailure(exit)) return yield* exit;
            yield* submit(() => reconcileAll((surface) => wants(surface, target)));
          });

        if (snapshot.manifest) {
          const target = pick(snapshot.manifest.engines, module, engine);
          if (target instanceof Error) return Effect.fail(target);
          selections++;
          apply(target);
          return submit(() =>
            Effect.gen(function* () {
              if (cancelled()) return yield* cancellation();
              yield* start;
            }),
          ).pipe(Effect.andThen(settle(target)));
        }

        const call = ++selections;
        const release = hold({ increment: () => reading++, decrement: () => reading-- });
        for (const surface of surfaces.values()) if (surface.override === undefined) surface.suspended = true;
        let applied: Selection | undefined;
        return submit(() =>
          Effect.gen(function* () {
            if (cancelled()) return yield* cancellation();
            const target = yield* resolve(module, engine);
            if (cancelled()) return yield* cancellation();
            // A later selection owns the surfaces; booting this module would only hold up its turn in the mailbox.
            if (call !== selections) return;
            apply(target);
            applied = target;
            release();
            yield* start;
          }).pipe(
            Effect.catch((error) => restore(release, error)),
            Effect.ensuring(Effect.sync(release)),
          ),
        ).pipe(Effect.andThen(Effect.suspend(() => (applied === undefined ? Effect.void : settle(applied)))));
      }),
    deselect: () =>
      Effect.suspend(() => {
        if (closed) return Effect.fail(new Error("Router is closed"));
        selections++;
        apply(undefined);
        for (const surface of surfaces.values()) {
          surface.overrides++;
          setOverride(surface, undefined);
        }
        return submit(() =>
          Effect.gen(function* () {
            for (const surface of surfaces.values()) yield* reconcile(surface);
          }),
        );
      }),
    override: (adapter, selection) =>
      Effect.suspend(() => {
        const surface = surfaces.get(adapter);
        if (!surface) return Effect.fail(new Error("Surface is not attached"));
        if (selection === undefined) {
          surface.overrides++;
          setOverride(surface, undefined);
          return submit(() => reconcile(surface));
        }

        const snapshot = registry.snapshot(selection.module);
        if (!snapshot) return Effect.fail(new Error(`Unknown module: ${selection.module}`));
        if (snapshot.manifest) {
          const target = pick(snapshot.manifest.engines, selection.module, selection.engine);
          if (target instanceof Error) return Effect.fail(target);
          surface.overrides++;
          setOverride(surface, target);
          return submit(() => reconcile(surface));
        }

        const call = ++surface.overrides;
        const release = hold({ increment: () => surface.reading++, decrement: () => surface.reading-- });
        surface.suspended = true;
        return submit(() =>
          Effect.gen(function* () {
            const target = yield* resolve(selection.module, selection.engine);
            if (call === surface.overrides) setOverride(surface, target);
            release();
            yield* reconcile(surface);
          }).pipe(
            Effect.catch((error) => restore(release, error)),
            Effect.ensuring(Effect.sync(release)),
          ),
        );
      }),
    keyAsync: (adapter, event) => {
      const surface = surfaces.get(adapter),
        context = surface?.active;
      if (!surface || !context || surface.suspended || !wants(surface, context)) return Promise.resolve("passthrough");
      return registry.keyAsync(context.module, context, event);
    },
    attach: (adapter, { keyMode = "sync" } = {}) => {
      if (closed) throw new Error("Router is closed");
      if (surfaces.has(adapter)) throw new Error("Surface is already attached");
      const surface: Surface = {
        adapter,
        ic: nextIc++,
        contexts: new Map(),
        attached: true,
        focused: adapter.element.ownerDocument.activeElement === adapter.element,
        suspended: false,
        reading: 0,
        overrides: 0,
        override: undefined,
        active: undefined,
        cleanup: () => {},
      };
      surfaces.set(adapter, surface);
      const focus = () => {
        surface.focused = true;
        mailbox.enqueue(() => reconcile(surface));
      };
      const blur = () => {
        const context = surface.active;
        const waitForBoundary = context && registry.captureDrainContext(context.module, context);
        surface.focused = false;
        surface.suspended = true;
        mailbox.enqueue(() =>
          Effect.gen(function* () {
            // Later focus intervals can accept keys before this mailbox item runs.
            // This blur waits only for owners captured at its actual event boundary.
            if (context && waitForBoundary) {
              yield* Effect.tryPromise({ try: waitForBoundary, catch: asError });
              context.finish();
              context.ready = false;
              context.acceptOutput = false;
            }
            if (context?.created && context.focused && live(context)) {
              context.focused = false;
              yield* request(context, new FocusOut({}));
              panel.enqueue({ _tag: "hide", module: context.module, ic: context.ic });
            }
            yield* reconcile(surface);
          }),
        );
      };
      const reset = () => {
        const context = surface.active;
        if (!context || !context.created || !live(context)) return;
        const generation = context.generation;
        let resume: (() => void) | undefined;
        let released = false;
        const pending: PendingReset = {
          context,
          generation,
          reserve: () => {
            if (!released && context.generation === generation && live(context))
              resume ??= registry.holdKeys(context.module);
          },
          release: () => {
            released = true;
            pendingResets.delete(pending);
            resume?.();
          },
        };
        pendingResets.add(pending);
        try {
          // Inactive contexts defer their reservation until reconciliation makes
          // them eligible, leaving older blur owners free to drain first.
          if (context.ready && !surface.suspended && wants(surface, context)) pending.reserve();
          registry.retireContext(context.module, context, () => context.preedit.finish(context.adapter));
          enqueueRefresh(surface, context);
          mailbox.enqueue(() =>
            Effect.gen(function* () {
              if (!wants(surface, context) || !live(context) || context.generation !== generation) return;
              yield* request(context, new Reset({}));
              yield* refresh(surface, context);
            }).pipe(Effect.ensuring(Effect.sync(pending.release))),
          );
        } catch (error) {
          pending.release();
          throw error;
        }
      };
      // Install adapter reset detection before the sink sees the same DOM event.
      const removeReset = adapter.onReset(reset);
      const key = (event: KeyboardEvent) => {
        if (adapter.contentType().disabled || event.isComposing || event.key === "Dead") return;
        if (event.type === "keydown")
          for (const binding of hotkeys)
            if (binding.predicate(event)) {
              binding.action();
              event.preventDefault();
              event.stopPropagation();
              return;
            }
        if (keyMode === "async") {
          void service.keyAsync(adapter, event).catch((cause) => {
            mailbox.enqueue(() => Effect.fail(asError(cause)));
          });
          return;
        }
        const context = surface.active;
        if (!context || surface.suspended || !wants(surface, context)) return;
        if (registry.keySink(context.module, context).key(event) === "consumed") {
          event.preventDefault();
          event.stopPropagation();
        }
      };
      adapter.element.addEventListener("focus", focus);
      adapter.element.addEventListener("blur", blur);
      if (keyMode !== "manual") {
        adapter.element.addEventListener("keydown", key, true);
        adapter.element.addEventListener("keyup", key, true);
      }
      surface.cleanup = () => {
        try {
          removeReset();
        } finally {
          adapter.element.removeEventListener("focus", focus);
          adapter.element.removeEventListener("blur", blur);
          adapter.element.removeEventListener("keydown", key, true);
          adapter.element.removeEventListener("keyup", key, true);
        }
      };
      if (surface.focused) mailbox.enqueue(() => reconcile(surface));
      return () => {
        const errors = detachSurface(surface);
        if (errors.length) throw new AggregateError(errors, "Surface teardown failed");
      };
    },
  };
  return service;
});
