// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Context, Effect, Layer, Logger as EffectLogger, ManagedRuntime, References, Schema, Stream } from "effect";
import {
  CoreConfig,
  CreateEngineError,
  ModuleRegistry,
  Logger,
  PanelEvents,
  Router,
  SettingsApi,
  SettingsSource,
  glibLevel,
  textareaAdapter,
  type AttachOptions,
  type AsyncKeyResult,
  type CoreConfigValues,
  type ModuleEvent,
  type ModuleRegistryService,
  type RouterService,
  type Selection,
  type SettingsApiService,
  type SettingsSourceService,
  type SurfaceAdapter,
} from "@ibus-web/core";
import { errorMessage, PanelAction, type EngineDescriptor } from "@ibus-web/protocol";
import type { PanelHost, PanelUpdate } from "@ibus-web/panel";
import { workerUrl } from "./worker.ts";
export type { AttachOptions, AsyncKeyResult, Selection, SurfaceAdapter, SettingsSourceService } from "@ibus-web/core";
export { CreateEngineError };
export type { EngineDescriptor } from "@ibus-web/protocol";
export type { PanelAction, PanelHost, PanelUpdate } from "@ibus-web/panel";
export { booleanVariant, int32Variant, stringVariant, variant } from "@ibus-web/protocol";
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly module?: string;
  readonly ic?: number;
  readonly domain?: string;
}
export interface IbusWebOptions {
  readonly hostUrl?: URL;
  readonly runtimeUrl: URL;
  readonly modules: Readonly<Record<string, URL>>;
  readonly settings?: SettingsSourceService;
  readonly logger?: (entry: LogEntry) => void;
  readonly logLevel?: LogLevel;
  readonly config?: Partial<CoreConfigValues>;
}
export interface IbusWebEventMap {
  modulestate: CustomEvent<Omit<Extract<ModuleEvent, { _tag: "state" }>, "_tag">>;
  storage: CustomEvent<Omit<Extract<ModuleEvent, { _tag: "storage" }>, "_tag">>;
  /** `null` after deselection: a CustomEvent can't carry an undefined detail. */
  selectionchange: CustomEvent<Selection | null>;
  panel: CustomEvent<PanelUpdate>;
  log: CustomEvent<LogEntry>;
}
export interface IbusWeb extends PanelHost {
  attach(element: HTMLInputElement | HTMLTextAreaElement, options?: AttachOptions): () => void;
  attachAdapter(adapter: SurfaceAdapter, options?: AttachOptions): () => void;
  /** Invoke during original dispatch; replayed means fallback is already applied. */
  keyAsync(adapter: SurfaceAdapter, event: KeyboardEvent): Promise<AsyncKeyResult>;
  /** Without an engine, selects the module's first. An unknown module or engine rejects before anything changes. */
  select(module: string, engine?: string): Promise<void>;
  /** Returns every surface to plain browser input; Workers stay loaded. */
  deselect(): Promise<void>;
  unload(module: string): Promise<void>;
  /** Development only: terminates the actual Worker and awaits normal recovery. */
  debugRestart(module: string): Promise<void>;
  /** Reads and validates the module's manifest without starting its Worker. */
  engines(module: string): Promise<EngineDescriptor[]>;
  readonly selection: Selection | undefined;
  readonly settings: Omit<SettingsApiService, "changes">;
  dispose(): Promise<void>;
  addEventListener<K extends keyof IbusWebEventMap>(
    type: K,
    listener: (event: IbusWebEventMap[K]) => void,
    options?: AddEventListenerOptions | boolean,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void;
}
interface Services {
  router: RouterService;
  registry: ModuleRegistryService;
  settings: SettingsApiService;
}
class FacadeServices extends Context.Service<FacadeServices, Services>()("ibus-web/FacadeServices") {}
const panelSchema = "org.freedesktop.ibus.panel",
  orientationKey = "lookup-table-orientation";
const decodePanelAction = Schema.decodeUnknownSync(PanelAction);
const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** No services or storage are acquired until selection, an engine listing or a settings operation; only selection starts Workers. */
export function createIbusWeb(options: IbusWebOptions): IbusWeb {
  const target = new EventTarget();
  const attachments = new Map<SurfaceAdapter, { options: AttachOptions; detach?: () => void }>();
  const orientations = new Map<string, 0 | 1>();
  let closed = false,
    services: Services | undefined,
    initializing: Promise<Services> | undefined,
    disposal: Promise<void> | undefined;
  const alive = () => {
    if (closed) throw new Error("IbusWeb is disposed");
  };
  const emit = <K extends keyof IbusWebEventMap>(type: K, detail: IbusWebEventMap[K]["detail"]) => {
    if (!closed) target.dispatchEvent(new CustomEvent(type, { detail }));
  };
  // Logs from synchronous adapter callbacks are delivered off the key stack.
  const log = (entry: LogEntry) => {
    if (levels[entry.level] < levels[options.logLevel ?? "info"] || closed) return;
    queueMicrotask(() => {
      if (closed) return;
      emit("log", entry);
      try {
        options.logger?.(entry);
      } catch {
        /* A host logger must not break input or panel recovery. */
      }
    });
  };
  const orientation = (module: string, value: unknown) => {
    const next = value === 0 ? 0 : 1;
    if (orientations.get(module) === next) return;
    orientations.set(module, next);
    const context = services?.router.activeContext();
    if (context?.module === module) emit("panel", { _tag: "orientation", module, ic: context.ic });
  };
  const refreshOrientation = async (module: string, api: SettingsApiService) => {
    const schemas = await api.schemas(module);
    if (
      !schemas.some(
        (schema) =>
          schema.id === panelSchema &&
          schema.path === "/desktop/ibus/panel/" &&
          schema.keys.some((key) => key.name === orientationKey),
      )
    )
      return;
    const value = await api.get(module, panelSchema, orientationKey);
    orientation(module, "value" in value.value ? value.value.value : undefined);
  };
  const base = Layer.mergeAll(
    CoreConfig.layer(options.config),
    PanelEvents.Default,
    options.settings ? Layer.succeed(SettingsSource, options.settings) : SettingsSource.Default,
    Layer.succeed(Logger, {
      enqueue: ({ module, ic, record }) =>
        log({
          module,
          ic,
          domain: record.domain,
          message: record.message,
          level: glibLevel(record.level).toLowerCase() as LogLevel,
        }),
    }),
  );
  const registry = ModuleRegistry.layer({
    hostUrl: options.hostUrl ?? workerUrl,
    runtimeUrl: options.runtimeUrl,
    modules: options.modules,
  }).pipe(Layer.provideMerge(base));
  const dependencies = Layer.mergeAll(Router.Default, SettingsApi.layer({ modules: options.modules })).pipe(
    Layer.provideMerge(registry),
  );
  const layer = Layer.effect(
    FacadeServices,
    Effect.gen(function* () {
      const router = yield* Router,
        registry = yield* ModuleRegistry,
        settings = yield* SettingsApi;
      yield* registry.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event._tag === "state") emit("modulestate", { module: event.module, state: event.state });
            else emit("storage", { module: event.module, state: event.state, message: event.message });
          }),
        ),
        Effect.forkScoped,
      );
      yield* router.panel.pipe(
        Stream.runForEach((event) => Effect.sync(() => emit("panel", event))),
        Effect.forkScoped,
      );
      yield* router.selectionChanges.pipe(
        Stream.runForEach((selection) => Effect.sync(() => emit("selectionchange", selection ?? null))),
        Effect.forkScoped,
      );
      yield* settings.changes.pipe(
        Stream.runForEach((change) =>
          Effect.sync(() => {
            if (change.schemaId !== panelSchema || change.key !== orientationKey) return;
            for (const module of orientations.keys())
              orientation(module, "value" in change.value.value ? change.value.value.value : undefined);
          }),
        ),
        Effect.forkScoped,
      );
      return { router, registry, settings };
    }),
  ).pipe(
    Layer.provide(dependencies),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, "All")),
    Layer.provide(
      EffectLogger.layer([
        EffectLogger.make((entry) => {
          const level =
            entry.logLevel === "Fatal" || entry.logLevel === "Error"
              ? "error"
              : entry.logLevel === "Warn"
                ? "warn"
                : entry.logLevel === "Info"
                  ? "info"
                  : "debug";
          log({ level, message: errorMessage(entry.message) });
        }),
      ]),
    ),
  );
  const runtime = ManagedRuntime.make(layer);
  const initialize = (): Promise<Services> => {
    alive();
    return (initializing ??= runtime.runPromise(FacadeServices).then((value) => {
      alive();
      services = value;
      for (const [adapter, entry] of attachments) entry.detach = value.router.attach(adapter, entry.options);
      return value;
    }));
  };
  const attachAdapter = (adapter: SurfaceAdapter, attachOptions: AttachOptions = {}) => {
    alive();
    if ([...attachments.keys()].some((item) => item === adapter || item.element === adapter.element))
      throw new Error("Surface is already attached");
    const entry: { options: AttachOptions; detach?: () => void } = { options: attachOptions };
    attachments.set(adapter, entry);
    if (services) entry.detach = services.router.attach(adapter, attachOptions);
    return () => {
      if (attachments.get(adapter) !== entry) return;
      attachments.delete(adapter);
      entry.detach?.();
    };
  };
  const app: IbusWeb = Object.assign(target, {
    attach: (element: HTMLInputElement | HTMLTextAreaElement, attachOptions?: AttachOptions) =>
      attachAdapter(textareaAdapter(element), attachOptions),
    attachAdapter,
    keyAsync: (adapter: SurfaceAdapter, event: KeyboardEvent): Promise<AsyncKeyResult> =>
      services && !closed ? services.router.keyAsync(adapter, event) : Promise.resolve("passthrough"),
    select: async (module: string, engine?: string) => {
      const current = await initialize();
      await runtime.runPromise(current.router.select(module, engine));
      await refreshOrientation(module, current.settings);
    },
    deselect: async () => {
      alive();
      if (!initializing) return;
      const current = await initialize();
      await runtime.runPromise(current.router.deselect());
    },
    unload: async (module: string) => {
      alive();
      if (!Object.hasOwn(options.modules, module)) throw new Error(`Unknown module: ${module}`);
      if (!initializing) return;
      const current = await initialize();
      await runtime.runPromise(current.router.unload(module));
    },
    debugRestart: async (module: string) => {
      const current = await initialize();
      const selection = current.router.selection;
      await runtime.runPromise(current.registry.debugRestart(module));
      if (selection?.module === module) await runtime.runPromise(current.router.select(module, selection.engine));
    },
    engines: async (module: string) => {
      alive();
      if (!Object.hasOwn(options.modules, module)) throw new Error(`Unknown module: ${module}`);
      const current = await initialize();
      return [...(await runtime.runPromise(current.registry.engines(module)))];
    },
    selection: undefined as Selection | undefined,
    settings: {
      schemas: async (module: string) => {
        const current = await initialize();
        const schemas = await current.settings.schemas(module);
        await refreshOrientation(module, current.settings);
        return schemas;
      },
      get: async (module: string, schema: string, key: string) => {
        const current = await initialize();
        return current.settings.get(module, schema, key);
      },
      set: async (module: string, schema: string, key: string, value: Parameters<SettingsApiService["set"]>[3]) => {
        const current = await initialize();
        await current.settings.set(module, schema, key, value);
        await refreshOrientation(module, current.settings);
      },
      reset: async (module: string, schema: string, key: string) => {
        const current = await initialize();
        await current.settings.reset(module, schema, key);
        await refreshOrientation(module, current.settings);
      },
    },
    caretRect: () => {
      if (closed) return null;
      const adapter = services?.router.activeContext()?.adapter;
      return adapter?.caretRect() ?? null;
    },
    lookupTableOrientation: (module: string): 0 | 1 => orientations.get(module) ?? 1,
    sendPanelAction: (module: string, ic: number, action: PanelAction) => {
      alive();
      const context = services?.router.activeContext();
      if (!context || context.module !== module || context.ic !== ic) return;
      try {
        // Public structural actions cross into the protocol's validated request classes here.
        const request = decodePanelAction(action);
        void services!.registry.request(module, request, ic).catch((error: unknown) => app.reportPanelError(error));
      } catch (error) {
        app.reportPanelError(error);
      }
    },
    reportPanelError: (error: unknown) => {
      log({ level: "error", domain: "panel", message: errorMessage(error) });
    },
    dispose: () => {
      if (disposal) return disposal;
      // Publish the promise before adapter callbacks can throw or reenter disposal.
      let resolve!: () => void, reject!: (error: unknown) => void;
      disposal = new Promise<void>((done, failed) => {
        resolve = done;
        reject = failed;
      });
      closed = true;
      const errors: unknown[] = [];
      for (const entry of attachments.values()) {
        try {
          entry.detach?.();
        } catch (error) {
          errors.push(error);
        }
      }
      attachments.clear();
      orientations.clear();
      void runtime.dispose().then(
        () => (errors.length ? reject(new AggregateError(errors, "IbusWeb disposal failed")) : resolve()),
        (error: unknown) => reject(new AggregateError([...errors, error], "IbusWeb disposal failed")),
      );
      return disposal;
    },
  });
  // Object.assign copies a getter's value once, so the live getter is defined afterwards.
  Object.defineProperty(app, "selection", {
    enumerable: true,
    get: () => (closed ? undefined : services?.router.selection),
  });
  return app;
}
