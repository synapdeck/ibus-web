// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Effect, Layer, Logger as EffectLogger } from "effect";
import { expect, inject } from "vitest";
import { stringVariant, type DecodedLazyRecord, type Request } from "@ibus-web/protocol";
import {
  Connection,
  CoreConfig,
  ModuleRegistry,
  Logger,
  PanelEvents,
  Router,
  SettingsSource,
  makeModuleRegistry,
  textareaAdapter,
  type CrashInfo,
  type KeyContext,
  type Preedit,
  type LogLine,
} from "../../src/page/index.ts";

interface RealHostData {
  hostUrl: string;
  runtimes: { name: string; url: string }[];
  hangulUrl: string;
  recoverableUrl: string;
}
declare module "vitest" {
  interface ProvidedContext {
    realHost: RealHostData;
  }
}
export const data = inject("realHost");
if (data.runtimes.length !== 2)
  throw new Error("Real host tests require IBUS_WEB_WORKER_HOST_TESTS and IBUS_WEB_HANGUL_MANIFEST");
export const HANGUL_SCHEMA = "org.freedesktop.ibus.engine.hangul";
export const HANGUL_PATH = "/org/freedesktop/ibus/engine/hangul/";
export interface Field {
  element: HTMLTextAreaElement | HTMLInputElement;
  adapter: ReturnType<typeof textareaAdapter>;
  preedits: (Preedit | undefined)[];
  inputs: { value: string; data: string | null; source: "adapter" | "default" }[];
}
export const runHost = (
  runtime: RealHostData["runtimes"][number],
  engine: "hangul" | "recoverable",
  body: (session: {
    router: Router["Service"];
    registry: ModuleRegistry["Service"];
    contexts: Map<HTMLElement, KeyContext>;
    records: DecodedLazyRecord[];
    requests: { request: Request; ic: number; generation: number }[];
    connections: Connection[];
    crashes: CrashInfo[];
    logs: LogLine[];
    lifecycleWarnings: Request["_tag"][];
    field: (type?: "textarea" | "password") => Field;
    focus: (field: Field) => Promise<void>;
    settle: () => Promise<void>;
    press: (field: Field, key: string, code?: string) => Promise<KeyboardEvent>;
    dispatch: (field: Field, key: string, code?: string) => KeyboardEvent;
    nextCrash: () => Promise<CrashInfo>;
  }) => Promise<void>,
) => {
  const logs: LogLine[] = [];
  const crashes: CrashInfo[] = [];
  const failedRequests: { request: Request; cause: unknown; reported: boolean }[] = [];
  const lifecycleWarnings: Request["_tag"][] = [];
  const unexpectedLogs: EffectLogger.Options<unknown>[] = [];
  const frameworkLogger = EffectLogger.make((options) => {
    const failure = failedRequests.find((failure) => !failure.reported && failure.cause === crashes.at(-1));
    const messages = options.message;
    if (
      engine === "recoverable" &&
      options.logLevel === "Warn" &&
      options.cause.reasons.length === 0 &&
      Array.isArray(messages) &&
      messages.length === 1 &&
      messages[0] instanceof Error &&
      messages[0].message === "[object Object]" &&
      failure &&
      ["Reset", "SetSurroundingText"].includes(failure.request._tag)
    ) {
      failure.reported = true;
      lifecycleWarnings.push(failure.request._tag);
    } else {
      unexpectedLogs.push(options);
      EffectLogger.defaultLogger.log(options);
    }
  });
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        expect(data.runtimes.length).toBe(2);
        expect(crossOriginIsolated).toBe(true);
        const alias = "selected-engine";
        const connections: Connection[] = [];
        const contexts = new Map<HTMLElement, KeyContext>();
        const records: DecodedLazyRecord[] = [];
        const requests: { request: Request; ic: number; generation: number }[] = [];
        const crashWaiters: ((crash: CrashInfo) => void)[] = [];
        const registry = yield* makeModuleRegistry({
          hostUrl: new URL(data.hostUrl, location.href),
          runtimeUrl: new URL(runtime.url, location.href),
          modules: { [alias]: new URL(engine === "hangul" ? data.hangulUrl : data.recoverableUrl, location.href) },
          storage: "none",
          start: async (options) => {
            const connection = await Connection.start(options);
            connections.push(connection);
            connection.onCrash((crash) => {
              crashes.push(crash);
              for (const resolve of crashWaiters.splice(0)) resolve(crash);
            });
            return connection;
          },
        });
        const register = registry.registerContext;
        registry.registerContext = (name, context) => {
          contexts.set(context.adapter.element, context);
          const apply = context.apply;
          context.apply = (record) => {
            records.push(record);
            apply.call(context, record);
          };
          return register(name, context);
        };
        const request = registry.request;
        registry.request = (name, requestValue, ic) => {
          requests.push({ request: requestValue, ic, generation: registry.snapshot(name)!.generation });
          return request(name, requestValue, ic).catch((cause: unknown) => {
            failedRequests.push({ request: requestValue, cause, reported: false });
            throw cause;
          });
        };
        yield* Effect.gen(function* () {
          const router = yield* Router;
          yield* router.select(alias);
          const elements: HTMLElement[] = [];
          const disposers: (() => void)[] = [];
          const field = (type: "textarea" | "password" = "textarea"): Field => {
            const element = document.createElement(type === "textarea" ? "textarea" : "input");
            if (element instanceof HTMLInputElement) element.type = type;
            document.body.append(element);
            elements.push(element);
            const preedits: (Preedit | undefined)[] = [];
            const inputs: Field["inputs"] = [];
            element.addEventListener("input", (event) => {
              inputs.push({
                value: element.value,
                data: (event as InputEvent).data,
                source: simulatingDefault ? "default" : "adapter",
              });
            });
            const adapter = textareaAdapter(element, { onPreedit: (value) => preedits.push(value) });
            disposers.push(router.attach(adapter));
            return { element, adapter, preedits, inputs };
          };
          let simulatingDefault = false;
          const settle = async () => {
            for (const context of contexts.values()) await registry.drainContext(alias, context);
            // A submitted selection of the existing alias is a FIFO lifecycle/refresh barrier.
            await Effect.runPromise(router.select(alias));
          };
          const focus = async (field: Field) => {
            field.element.focus();
            await settle();
            if (!field.adapter.contentType().disabled) expect(contexts.get(field.element)?.ready).toBe(true);
          };
          const dispatch = (
            field: Field,
            key: string,
            code = [...key].length === 1 ? `Key${key.toUpperCase()}` : key,
          ) => {
            const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
            expect(event.getModifierState("CapsLock")).toBe(false);
            field.element.dispatchEvent(event);
            // Constructed KeyboardEvents have no native insertion. Only this helper emulates
            // the printable default action, after the real Router decides interception.
            if (!event.defaultPrevented && [...key].length === 1) {
              simulatingDefault = true;
              try {
                field.element.setRangeText(key, field.element.selectionStart!, field.element.selectionEnd!, "end");
                field.element.dispatchEvent(
                  new InputEvent("input", {
                    bubbles: true,
                    composed: true,
                    inputType: "insertText",
                    data: key,
                  }),
                );
              } finally {
                simulatingDefault = false;
              }
            }
            return event;
          };
          const press = async (field: Field, key: string, code?: string) => {
            const event = dispatch(field, key, code);
            await settle();
            field.element.dispatchEvent(
              new KeyboardEvent("keyup", {
                key,
                code: event.code,
                bubbles: true,
                cancelable: true,
              }),
            );
            await settle();
            return event;
          };
          try {
            yield* Effect.promise(() =>
              body({
                router,
                registry,
                contexts,
                records,
                requests,
                connections,
                crashes,
                logs,
                lifecycleWarnings,
                field,
                focus,
                settle,
                press,
                dispatch,
                nextCrash: () => new Promise((resolve) => crashWaiters.push(resolve)),
              }),
            );
            for (const line of logs.filter((line) => line.record.level & (4 | 8 | 16))) {
              expect(engine).toBe("recoverable");
              expect(line.record.level).toBe(16);
              expect(line.record.domain).toBe("ibus-web");
              expect(line.record.message).toBe("An engine threw: recoverable key failed");
            }
            expect(unexpectedLogs).toEqual([]);
          } finally {
            for (const dispose of disposers) dispose();
            for (const element of elements) element.remove();
          }
        }).pipe(Effect.provide(Router.Default), Effect.provideService(ModuleRegistry, registry));
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          CoreConfig.Default,
          EffectLogger.layer([frameworkLogger]),
          Layer.succeed(Logger, { enqueue: (line) => logs.push(line) }),
          PanelEvents.Default,
          SettingsSource.layer({ [HANGUL_PATH]: { "hanja-keys": stringVariant("Hangul_Hanja,F9,F8") } }),
        ),
      ),
    ),
  );
};
