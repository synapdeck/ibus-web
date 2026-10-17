// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Context, Effect, Layer, Logger as EffectLogger, ManagedRuntime, References, Schema, Stream } from "effect";
import {
  CoreConfig,
  ModuleRegistry,
  Logger,
  PanelEvents,
  Router,
  SettingsApi,
  SettingsSource,
  StorageApi,
  glibLevel,
  textareaAdapter,
  type AttachOptions,
  type AsyncKeyResult,
  type CoreConfigValues,
  type EngineInfo,
  type ModuleEvent,
  type PreloadEntry,
  type PreloadOptions,
  type ModuleRegistryService,
  type RouterService,
  type Selection,
  type SettingsApiService,
  type SettingsSourceService,
  type StorageApiService,
  type StorageUsage,
  type SurfaceAdapter,
} from "@ibus-web/core";
import { errorMessage, PanelAction } from "@ibus-web/protocol";
import type { PanelHost, PanelUpdate } from "@ibus-web/panel";
import { workerUrl } from "./worker.ts";
export type {
  AttachOptions,
  AsyncKeyResult,
  EngineInfo,
  EngineUsage,
  KeyboardLayout,
  ModuleUsage,
  PreloadEntry,
  PreloadOptions,
  Selection,
  SettingsSourceService,
  StorageUsage,
  SurfaceAdapter,
  VersionUsage,
} from "@ibus-web/core";
// The errors calls reject with and modulestate events carry: Error subclasses with a `_tag`, the same classes
// ibus-web/effect exports, so instanceof holds across both.
export {
  CreateEngineError,
  EngineCrashed,
  EngineHung,
  EngineLoadFailed,
  isIbusWebError,
  PrepareEngineError,
  ProtocolError,
  ProtocolMismatch,
  RuntimeAbiMismatch,
  StorageUnavailable,
  type CrashReasonName,
  type IbusWebError,
  type IbusWebErrorFields,
} from "@ibus-web/core";
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
  /** `error` says why the module is `restarting` or `failed`. */
  modulestate: CustomEvent<Omit<Extract<ModuleEvent, { _tag: "state" }>, "_tag">>;
  storage: CustomEvent<Omit<Extract<ModuleEvent, { _tag: "storage" }>, "_tag">>;
  /**
   * While an engine's own data installs: bytes written so far of total, what the module's storage lacked. bytes reaches
   * total only once all of it is installed.
   */
  install: CustomEvent<Omit<Extract<ModuleEvent, { _tag: "install" }>, "_tag">>;
  /**
   * While preload entries are fetched: bytes so far of total, what the cache lacked, in the manifest's sizes. bytes
   * reaches total only once all of it is stored. engine is the entry's, if it named one; an install reports the base
   * data without one.
   */
  preload: CustomEvent<Omit<Extract<ModuleEvent, { _tag: "preload" }>, "_tag">>;
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
  /**
   * Without an engine, selects the module's first. An unknown module or engine rejects before anything changes; a
   * module that fails to start rejects with its IbusWebError.
   */
  select(module: string, engine?: string): Promise<void>;
  /** Returns every surface to plain browser input; Workers stay loaded. */
  deselect(): Promise<void>;
  unload(module: string): Promise<void>;
  /** Development only: terminates the actual Worker and awaits normal recovery. */
  debugRestart(module: string): Promise<void>;
  /**
   * Reads and validates the module's manifest without starting its Worker. Each engine's `layout` is the layout its
   * keys follow now, its `layout` setting at `layoutPath` or else the `keyboard.layout` it declares.
   */
  engines(module: string): Promise<EngineInfo[]>;
  /**
   * Installs the engine's own data ahead of selection, starting the module's Worker if it hasn't, so that selecting
   * the engine later waits for nothing; `install` events report its progress. An engine with no data of its own needs
   * nothing. Rejects with a PrepareEngineError carrying the Worker's diagnostic.
   */
  prepare(module: string, engine: string): Promise<void>;
  /**
   * Once the page is idle, fetches what the page's cache lacks of each entry, at low priority, without starting a
   * Worker: the module's manifest, `.wasm` and base data, and the engine's own data when the entry names one. A
   * module's Worker reads them from there. With `install: true`, a short-lived Worker per module installs them into
   * its storage instead, so that the first selection only starts the module; it needs the module's writer lock, and
   * a module another tab holds is skipped. `preload` events report its progress. Rejects with a plain Error for an
   * unknown module or engine, and with the tagged errors for what failed.
   */
  preload(entries: readonly PreloadEntry[], options?: PreloadOptions): Promise<void>;
  readonly selection: Selection | undefined;
  readonly settings: Omit<SettingsApiService, "changes">;
  /**
   * The modules' storage. `usage()` reads every module's, starting no module's Worker; `export(module)` gives its user
   * data as a tar Blob, having the Worker that writes it, in this tab or another, persist first; `reset(module)` deletes
   * its user data, and a module that was running starts again. They reject with StorageUnavailable when storage can't
   * be read or reset.
   */
  readonly storage: {
    usage(): Promise<StorageUsage>;
    export(module: string): Promise<Blob>;
    reset(module: string): Promise<void>;
  };
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
  storage: StorageApiService;
}
class FacadeServices extends Context.Service<FacadeServices, Services>()("ibus-web/FacadeServices") {}
const panelSchema = "org.freedesktop.ibus.panel",
  panelPath = "/desktop/ibus/panel/",
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
          schema.paths.includes(panelPath) &&
          schema.keys.some((key) => key.name === orientationKey),
      )
    )
      return;
    const value = await api.get(module, panelPath, orientationKey);
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
  const routed = Layer.mergeAll(Router.Default, SettingsApi.layer({ modules: options.modules })).pipe(
    Layer.provideMerge(registry),
  );
  const dependencies = StorageApi.layer({ hostUrl: options.hostUrl ?? workerUrl, modules: options.modules }).pipe(
    Layer.provideMerge(routed),
  );
  const layer = Layer.effect(
    FacadeServices,
    Effect.gen(function* () {
      const router = yield* Router,
        registry = yield* ModuleRegistry,
        settings = yield* SettingsApi,
        storage = yield* StorageApi;
      yield* registry.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event._tag === "state")
              emit("modulestate", {
                module: event.module,
                state: event.state,
                ...(event.error === undefined ? {} : { error: event.error }),
              });
            else if (event._tag === "storage")
              emit("storage", { module: event.module, state: event.state, message: event.message });
            else if (event._tag === "install")
              emit("install", { module: event.module, engine: event.engine, bytes: event.bytes, total: event.total });
            else
              emit("preload", {
                module: event.module,
                ...(event.engine === undefined ? {} : { engine: event.engine }),
                bytes: event.bytes,
                total: event.total,
              });
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
            if (change.schemaId !== panelSchema || change.path !== panelPath || change.key !== orientationKey) return;
            for (const module of orientations.keys())
              orientation(module, "value" in change.value.value ? change.value.value.value : undefined);
          }),
        ),
        Effect.forkScoped,
      );
      return { router, registry, settings, storage };
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
    prepare: async (module: string, engine: string) => {
      alive();
      if (!Object.hasOwn(options.modules, module)) throw new Error(`Unknown module: ${module}`);
      const current = await initialize();
      await runtime.runPromise(current.registry.prepare(module, engine));
    },
    preload: async (entries: readonly PreloadEntry[], preloadOptions?: PreloadOptions) => {
      alive();
      const unknown = entries.find(({ module }) => !Object.hasOwn(options.modules, module));
      if (unknown !== undefined) throw new Error(`Unknown module: ${unknown.module}`);
      const current = await initialize();
      await runtime.runPromise(current.registry.preload(entries, preloadOptions));
    },
    selection: undefined as Selection | undefined,
    settings: {
      schemas: async (module: string) => {
        const current = await initialize();
        const schemas = await current.settings.schemas(module);
        await refreshOrientation(module, current.settings);
        return schemas;
      },
      get: async (module: string, path: string, key: string) => {
        const current = await initialize();
        return current.settings.get(module, path, key);
      },
      set: async (module: string, path: string, key: string, value: Parameters<SettingsApiService["set"]>[3]) => {
        const current = await initialize();
        await current.settings.set(module, path, key, value);
        await refreshOrientation(module, current.settings);
      },
      reset: async (module: string, path: string, key: string) => {
        const current = await initialize();
        await current.settings.reset(module, path, key);
        await refreshOrientation(module, current.settings);
      },
    },
    storage: {
      usage: async () => {
        const current = await initialize();
        return runtime.runPromise(current.storage.usage());
      },
      export: async (module: string) => {
        const current = await initialize();
        return runtime.runPromise(current.storage.export(module));
      },
      reset: async (module: string) => {
        const current = await initialize();
        await runtime.runPromise(current.storage.reset(module));
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
