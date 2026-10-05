// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Effect, Layer } from "effect";
import type { DecodedRecord, EngineManifest, OutputRecord, Request } from "@ibus-web/protocol";
import { makeRouter } from "../../src/router/router.ts";
import { makeEngineRegistry, EngineRegistry } from "../../src/services/engines.ts";
import { CoreConfig } from "../../src/services/config.ts";
import { Logger, PanelEvents } from "../../src/services/logging.ts";
import { SettingsSource } from "../../src/services/settings.ts";
import { textareaAdapter } from "../../src/adapters/textarea.ts";
import { FakeConnection } from "./support.ts";
export const text = (value: string) => ({ attachments: {}, text: value, attrs: { attachments: {}, attributes: [] } });
export const record = (value: OutputRecord, ic = 1): DecodedRecord => ({
  record: value,
  ic,
  seq: 1,
  flags: 0,
  size: 16,
});
export const key = (element: HTMLElement, value = "a", type = "keydown") => {
  const event = new KeyboardEvent(type, {
    key: value,
    code: `Key${value.toUpperCase()}`,
    bubbles: true,
    cancelable: true,
  });
  element.dispatchEvent(event);
  return event;
};
export const preedit = (value = "한", mode = 1) =>
  record({ _tag: "UpdatePreeditText", text: text(value), cursor: [...value].length, visible: true, mode });
export const emptyReply = { ret: 0, outSeq: 0, records: [] };
const url = new URL("https://example.test/");
const manifest: EngineManifest = {
  name: "distribution",
  keyboard: { layout: "us", passThrough: [] },
  version: "1",
  license: "MIT",
  runtimeAbi: 1,
  protocol: 1,
  module: { url: "engine.so", size: 1 },
  memory: 65536,
  threads: 0,
  data: [{ storePath: `/nix/store/${"a".repeat(32)}-test`, url: "data.tar", size: 0, encoding: "identity" }],
  settingsSchemaDir: `/nix/store/${"a".repeat(32)}-test/schemas`,
  engines: ["factory"],
  settingsSchemas: [],
};
export class DomConnection extends FakeConnection {
  hold: Request["_tag"] | undefined;
  observed: (() => void)[] = [];
  override requestAsync(request: Request, ic: number) {
    const pending = request._tag === this.hold ? super.requestAsync(request, ic) : undefined;
    if (!pending) this.sent.push({ mode: "async", request, ic });
    for (const notify of this.observed.splice(0)) notify();
    return pending ?? Promise.resolve(emptyReply);
  }
  untilSent(tag: Request["_tag"]): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.sent.some((x) => x.request._tag === tag)) resolve();
        else this.observed.push(check);
      };
      check();
    });
  }
}
export const run = (
  test: (h: {
    router: Effect.Success<typeof makeRouter>;
    registry: Effect.Success<ReturnType<typeof makeEngineRegistry>>;
    connections: Record<string, DomConnection[]>;
    field: (value?: string) => {
      element: HTMLTextAreaElement;
      adapter: ReturnType<typeof textareaAdapter>;
      detach: () => void;
      seen: unknown[];
    };
  }) => Promise<void>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connections: Record<string, DomConnection[]> = { a: [], b: [] };
        const registry = yield* makeEngineRegistry({
          hostUrl: url,
          runtimeUrl: url,
          engines: { a: new URL("a", url), b: new URL("b", url) },
          loadManifest: async (url) => ({ ...manifest, name: `distribution-${url.pathname.slice(1)}` }),
          start: async (options) => {
            const c = new DomConnection();
            connections[options.manifestUrl.pathname.slice(1)]!.push(c);
            return c;
          },
          waitForWriter: () => Effect.void,
        });
        const router = yield* makeRouter.pipe(Effect.provideService(EngineRegistry, registry));
        yield* router.select("a");
        const field = (value = "") => {
          const element = document.createElement("textarea");
          element.value = value;
          document.body.append(element);
          element.setSelectionRange(value.length, value.length);
          const seen: unknown[] = [];
          const adapter = textareaAdapter(element, { onPreedit: (p) => seen.push(p) });
          const detach = router.attach(adapter);
          return { element, adapter, detach, seen };
        };
        yield* Effect.promise(() => test({ router, registry, connections, field }));
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(CoreConfig.Default, SettingsSource.Default, Logger.Default, PanelEvents.Default)),
    ),
  );
export const select = (router: Effect.Success<typeof makeRouter>, name = "a") => Effect.runPromise(router.select(name));
