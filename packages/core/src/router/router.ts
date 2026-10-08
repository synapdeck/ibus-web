// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Context, Effect, Layer, type Stream } from "effect";
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
  type PanelEvent,
  type Request,
} from "@ibus-web/protocol";
import { ModuleRegistry } from "../services/modules.ts";
import { CoreConfig } from "../services/config.ts";
import { PanelEvents, SyncMailbox } from "../services/logging.ts";
import type { AsyncKeyResult, SurfaceAdapter } from "./replay.ts";
import { InputContext } from "./contexts.ts";
export interface HotkeyRegistry {
  add(predicate: (event: KeyboardEvent) => boolean, action: () => void): () => void;
}
export interface AttachOptions {
  /** sync preserves native passthrough; async owns fallback; manual leaves keyboard capture to the editor. */
  readonly keyMode?: "sync" | "async" | "manual";
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
  select(module: string): Effect.Effect<void, Error>;
  unload(module: string): Effect.Effect<void, Error>;
  activeContext(): { module: string; ic: number; adapter: SurfaceAdapter } | undefined;
  override(adapter: SurfaceAdapter, module: string | undefined): Effect.Effect<void, Error>;
  readonly hotkeys: HotkeyRegistry;
  readonly panel: Stream.Stream<PanelEvent>;
}
export class Router extends Context.Service<Router, RouterService>()("@ibus-web/core/Router") {
  static readonly Default = Layer.effect(
    Router,
    Effect.suspend(() => makeRouter),
  );
}
interface Surface {
  readonly adapter: SurfaceAdapter;
  readonly ic: number;
  readonly contexts: Map<string, InputContext>;
  attached: boolean;
  focused: boolean;
  suspended: boolean;
  override: string | undefined;
  active: InputContext | undefined;
  cleanup: () => void;
}
interface PendingReset {
  readonly context: InputContext;
  readonly generation: number;
  reserve(): void;
  release(): void;
}
export const makeRouter = Effect.gen(function* () {
  const registry = yield* ModuleRegistry;
  const config = yield* CoreConfig;
  const panel = yield* PanelEvents;
  const surfaces = new Map<SurfaceAdapter, Surface>();
  // Unload bypasses the mailbox, so queued selections must retain their original lifetime.
  const selectionEpochs = new Map<string, number>();
  const hotkeys = new Set<{ predicate: (event: KeyboardEvent) => boolean; action: () => void }>();
  const mailbox = new SyncMailbox<() => Effect.Effect<void, Error>>();
  let selected: string | undefined,
    nextIc = 1,
    closed = false;
  const desired = (surface: Surface) => surface.override ?? selected;
  const wants = (surface: Surface, module: string) =>
    !closed &&
    surface.attached &&
    surface.focused &&
    !surface.adapter.contentType().disabled &&
    desired(surface) === module;
  const live = (context: InputContext) =>
    registry.snapshot(context.module)?.generation === context.generation &&
    !!registry.snapshot(context.module)?.connection;
  const request = (context: InputContext, message: Request) =>
    Effect.tryPromise({ try: () => registry.request(context.module, message, context.ic), catch: asError });
  const refresh = (surface: Surface, context: InputContext) =>
    Effect.gen(function* () {
      if (!wants(surface, context.module) || !context.created || !context.focused || !live(context)) return;
      for (const message of context.updates(config.surroundingWindow)) {
        if (!wants(surface, context.module) || !live(context)) return;
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
  const reconcile = (surface: Surface) =>
    Effect.gen(function* () {
      const module = desired(surface),
        old = surface.active;
      if (old && (!wants(surface, old.module) || module !== old.module)) {
        surface.suspended = true;
        yield* drain(old);
        old.finish();
        old.ready = false;
        old.acceptOutput = false;
        if (live(old) && old.created) {
          if (module !== old.module && old.enabled) {
            old.enabled = false;
            yield* request(old, new Disable({}));
          }
          if (old.focused) {
            old.focused = false;
            yield* request(old, new FocusOut({}));
          }
        }
        panel.enqueue({ _tag: "hide", module: old.module, ic: old.ic });
        if (module !== old.module) surface.active = undefined;
      }
      if (module === undefined || !wants(surface, module)) return;
      yield* registry.ensure(module);
      if (!wants(surface, module)) return;
      const snapshot = registry.snapshot(module)!;
      let context = surface.contexts.get(module);
      if (!context) {
        const created = new InputContext({
          ic: surface.ic,
          module,
          generation: snapshot.generation,
          adapter: surface.adapter,
          current: () =>
            surface.attached &&
            live(created) &&
            (created.created ? created.acceptOutput : wants(surface, module) && surface.active === created),
          refresh: () => enqueueRefresh(surface, created),
          panel: (event) => panel.enqueue(event),
        });
        context = created;
        surface.contexts.set(module, context);
        context.unregister = registry.registerContext(module, context);
      }
      surface.active = context;
      if (context.generation !== snapshot.generation) {
        context.invalidate();
        context.generation = snapshot.generation;
      }
      const generation = context.generation;
      const current = () => wants(surface, module) && live(context) && generation === context.generation;
      if (!context.created) {
        const reply = yield* request(context, new CreateEngine({ name: snapshot.manifest!.engines[0]! }));
        if (generation !== registry.snapshot(module)?.generation) return;
        if (reply.ret < 0) return;
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
    activeContext: () => {
      for (const surface of surfaces.values()) {
        const context = surface.active;
        if (context && surface.focused && surface.attached && context.ready && wants(surface, context.module))
          return { module: context.module, ic: context.ic, adapter: surface.adapter };
      }
      return undefined;
    },
    unload: (module) =>
      Effect.suspend(() => {
        if (closed) return Effect.fail(new Error("Router is closed"));
        if (!registry.snapshot(module)) return Effect.fail(new Error(`Unknown module: ${module}`));
        selectionEpochs.set(module, (selectionEpochs.get(module) ?? 0) + 1);
        const errors: unknown[] = [];
        if (selected === module) selected = undefined;
        for (const surface of surfaces.values()) {
          if (surface.override === module) surface.override = undefined;
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
    select: (module) =>
      Effect.suspend(() => {
        if (closed) return Effect.fail(new Error("Router is closed"));
        if (!registry.snapshot(module)) return Effect.fail(new Error(`Unknown module: ${module}`));
        const epoch = selectionEpochs.get(module) ?? 0;
        const cancelled = () => epoch !== (selectionEpochs.get(module) ?? 0);
        const previous = selected;
        selected = module;
        if (previous !== module)
          for (const surface of surfaces.values()) if (surface.override === undefined) surface.suspended = true;
        return submit(() =>
          Effect.gen(function* () {
            if (cancelled()) return yield* Effect.fail(new Error(`Selection of ${module} was cancelled by unload`));
            yield* registry.ensure(module);
            if (cancelled()) return yield* Effect.fail(new Error(`Selection of ${module} was cancelled by unload`));
            for (const surface of surfaces.values()) yield* reconcile(surface);
          }),
        );
      }),
    override: (adapter, module) =>
      Effect.suspend(() => {
        const surface = surfaces.get(adapter);
        if (!surface) return Effect.fail(new Error("Surface is not attached"));
        if (module !== undefined && !registry.snapshot(module))
          return Effect.fail(new Error(`Unknown module: ${module}`));
        if (surface.override !== module) {
          surface.override = module;
          surface.suspended = true;
        }
        return submit(() => reconcile(surface));
      }),
    keyAsync: (adapter, event) => {
      const surface = surfaces.get(adapter),
        context = surface?.active;
      if (!surface || !context || surface.suspended || !wants(surface, context.module))
        return Promise.resolve("passthrough");
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
          if (context.ready && !surface.suspended && wants(surface, context.module)) pending.reserve();
          registry.retireContext(context.module, context, () => context.preedit.finish(context.adapter));
          enqueueRefresh(surface, context);
          mailbox.enqueue(() =>
            Effect.gen(function* () {
              if (!wants(surface, context.module) || !live(context) || context.generation !== generation) return;
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
        if (!context || surface.suspended || !wants(surface, context.module)) return;
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
