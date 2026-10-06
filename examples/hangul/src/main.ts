// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Effect, Layer, Stream } from "effect";
import {
  Connection,
  CoreConfig,
  EngineRegistry,
  Logger,
  PanelEvents,
  Router,
  SettingsSource,
  textareaAdapter,
  type PanelEvent,
} from "@ibus-web/core";
import "./style.css";

const field = document.querySelector<HTMLTextAreaElement>("#input")!;
const enabled = document.querySelector<HTMLInputElement>("#enabled")!;
const preedit = document.querySelector<HTMLOutputElement>("#preedit")!;
const state = document.querySelector<HTMLOutputElement>("#engine")!;
const storage = document.querySelector<HTMLOutputElement>("#storage")!;
const mode = document.querySelector<HTMLOutputElement>("#mode")!;
const panel = document.querySelector<HTMLUListElement>("#panel")!;
const error = document.querySelector<HTMLParagraphElement>("#error")!;
const showPanel = (event: PanelEvent) => {
  if (event._tag === "hide") {
    panel.replaceChildren();
    mode.textContent = "—";
    return;
  }
  const record = event.record;
  let text: string;
  switch (record._tag) {
    case "UpdateLookupTable": {
      const page = record.table.visible();
      text = record.visible
        ? page.candidates
            .map((candidate, index) => `${page.labels[index]?.text ?? index + 1}: ${candidate.text}`)
            .join(" · ")
        : "Lookup table hidden";
      break;
    }
    case "UpdateAuxiliaryText":
      text = record.visible ? `Auxiliary: ${record.text.text}` : "Auxiliary text hidden";
      break;
    case "RegisterProperties": {
      const property = record.properties.properties.find((property) => property.key === "InputMode");
      if (property) mode.textContent = property.symbol.text;
      text = `Properties: ${record.properties.properties.map((property) => `${property.key}: ${property.symbol.text}`).join(" · ")}`;
      break;
    }
    case "UpdateProperty":
      if (record.property.key === "InputMode") mode.textContent = record.property.symbol.text;
      text = `${record.property.key}: ${record.property.symbol.text}`;
      break;
    default:
      text = record._tag;
  }
  const item = document.createElement("li");
  item.textContent = text;
  panel.prepend(item);
  while (panel.children.length > 30) panel.lastElementChild!.remove();
};

const abort = new AbortController();
const dispose = () => abort.abort();
window.addEventListener("pagehide", dispose, { once: true });
if (import.meta.hot) import.meta.hot.dispose(dispose);
const program = Effect.scoped(
  Effect.gen(function* () {
    const router = yield* Router;
    const registry = yield* EngineRegistry;
    yield* router.panel.pipe(
      Stream.runForEach((event) => Effect.sync(() => showPanel(event))),
      Effect.forkScoped,
    );
    const adapter = textareaAdapter(field, {
      onPreedit: (value) => {
        preedit.textContent = value?.text ?? "";
      },
    });
    let detach = router.attach(adapter);
    const toggle = () => {
      if (enabled.checked) detach = router.attach(adapter);
      else detach();
    };
    enabled.addEventListener("change", toggle);
    const timer = setInterval(() => {
      state.textContent = registry.snapshot("hangul")?.status ?? "starting";
    }, 100);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detach();
        clearInterval(timer);
        enabled.removeEventListener("change", toggle);
      }),
    );
    yield* router.select("hangul");
    state.textContent = registry.snapshot("hangul")!.status;
    enabled.disabled = false;
    yield* Effect.never;
  }),
).pipe(
  Effect.provide(Router.Default),
  Effect.provide(
    EngineRegistry.layer({
      hostUrl: new URL("/ibus-web/host/worker/index.js", location.href),
      runtimeUrl: new URL("/ibus-web/runtime/ibus-runtime.js", location.href),
      engines: { hangul: new URL("/ibus-web/hangul/manifest.json", location.href) },
      start: (options) =>
        Connection.start({
          ...options,
          worker: (url) => {
            storage.textContent = "starting";
            const worker = new Worker(url, { type: "module" });
            worker.addEventListener("message", (event: MessageEvent<{ type?: string; state?: string }>) => {
              if (event.data.type === "storage") storage.textContent = event.data.state ?? "unknown";
              // Browser storage reports deviations before the host announces its mounts ready.
              if (event.data.type === "ready" && storage.textContent === "starting")
                storage.textContent = "persistent (writable)";
            });
            return worker;
          },
        }),
    }),
  ),
  Effect.provide(
    Layer.mergeAll(
      CoreConfig.Default,
      Logger.Default,
      PanelEvents.Default,
      SettingsSource.layer({
        "org.freedesktop.ibus.engine.hangul": {
          "hanja-keys": { _tag: "v", type: "s", value: { _tag: "s", value: "Hangul_Hanja,F9,F8" } },
        },
      }),
    ),
  ),
);
void Effect.runPromise(program, { signal: abort.signal }).catch((cause: unknown) => {
  if (abort.signal.aborted) return;
  state.textContent = "failed";
  error.textContent = String(cause);
});
