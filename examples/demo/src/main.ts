// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  booleanVariant,
  createIbusWeb,
  int32Variant,
  stringVariant,
  type IbusWeb,
  type LogEntry,
  PrepareEngineError,
  type PanelUpdate,
  type Selection,
} from "ibus-web";
import { createPanel } from "ibus-web/panel";
import "ibus-web/panel/style.css";
import pinyinTones from "@ibus-web/example-pinyin-tones/module?ibus-module";
import "./style.css";

type SettingsKey = Awaited<ReturnType<IbusWeb["settings"]["schemas"]>>[number]["keys"][number];
type SettingValue = Awaited<ReturnType<IbusWeb["settings"]["get"]>>;
type Property = Extract<Extract<PanelUpdate, { _tag: "record" }>["record"], { _tag: "UpdateProperty" }>["property"];

const query = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const fields = [query<HTMLTextAreaElement>("#input"), query<HTMLInputElement>("#single-line")];
const picker = query<HTMLSelectElement>("#engine-picker");
const enabled = query<HTMLInputElement>("#enabled");
const state = query<HTMLOutputElement>("#engine");
const storage = query<HTMLOutputElement>("#storage");
const mode = query<HTMLOutputElement>("#mode");
const error = query<HTMLParagraphElement>("#error");
const logs = query<HTMLUListElement>("#log");
const restart = query<HTMLButtonElement>("#restart");
const form = query<HTMLFieldSetElement>("#settings");
const settingsState = query<HTMLOutputElement>("#settings-state");
const switches = query<HTMLDivElement>("#switches");
const install = query<HTMLOutputElement>("#install");
const preloadPicker = query<HTMLSelectElement>("#preload-picker");
const preloadButtons = [query<HTMLButtonElement>("#preload-fetch"), query<HTMLButtonElement>("#preload-install")];
const preloadState = query<HTMLOutputElement>("#preload");

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const logger = (entry: LogEntry) => {
  const item = document.createElement("li");
  item.textContent = `${entry.level}${entry.domain ? ` [${entry.domain}]` : ""}: ${entry.message}`;
  logs.append(item);
  while (logs.children.length > 100) logs.firstElementChild!.remove();
  logs.scrollTop = logs.scrollHeight;
};
const failure = (action: string, cause: unknown) => {
  error.textContent = `${action}: ${message(cause)}`;
  logger({ level: "error", message: error.textContent });
};

// The build serves every configured module under one directory, beside a map from module name to manifest.
const modulesUrl = new URL("/ibus-web/modules/", location.href);
const loadModules = async (): Promise<Record<string, URL>> => {
  const response = await fetch(new URL("modules.json", modulesUrl));
  if (!response.ok) throw new Error(`Module list fetch failed: ${response.status}`);
  const manifests = (await response.json()) as Record<string, string>;
  return Object.fromEntries(Object.entries(manifests).map(([name, path]) => [name, new URL(path, modulesUrl)]));
};

// The JavaScript module is built with the page and sits among the others in name order.
const modules = Object.fromEntries(
  Object.entries({ ...(await loadModules()), "pinyin-tones": new URL(pinyinTones, location.href) }).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  ),
);
const app = createIbusWeb({
  hostUrl: new URL("/ibus-web/host/worker/index.js", location.href),
  runtimeUrl: new URL("/ibus-web/runtime/ibus-runtime.js", location.href),
  modules,
  logger,
});
const panel = createPanel(app);
// The focused engine's properties, Mozc's input modes among them, sit beside the picker. Opened with ?properties=page,
// the page draws the engine's switches with controls of its own instead, as a page that styles its own would.
const ownSwitches = new URLSearchParams(location.search).get("properties") === "page";
if (!ownSwitches) picker.after(panel.properties);
let detaches = fields.map((field) => app.attach(field));

// Every engine of every module, in manifest order; the picker's option values index it.
const choices: Selection[] = [];
let last: Selection | undefined,
  shownSettings: string | undefined,
  shownEngine: string | undefined,
  // Whether some engine of the shown module owns settings, so the form follows the engine too.
  enginesOwnSettings = false,
  restarting = false;
// Each module's engine names, which say which settings paths belong to an engine.
const moduleEngines = new Map<string, readonly string[]>();
const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
// Engines group by language subtag, so scripts and variants of one language share a group. "und" and
// an unparsable code mean the engine names no language.
const languageOf = (code: string | undefined) => {
  if (code === undefined) return "";
  try {
    const { language } = new Intl.Locale(code);
    return language === "und" ? "" : language;
  } catch {
    return code;
  }
};
// A code Intl can't parse keeps its own spelling.
const languageName = (code: string) => {
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
};
const states = new Map<string, string>();
const storages = new Map<string, { text: string; reported: boolean }>();

const current = () => (app.selection ?? last)?.module;
const render = () => {
  const module = current();
  state.textContent = (module && states.get(module)) ?? "starting";
  storage.textContent = (module && storages.get(module)?.text) ?? "starting";
  restart.disabled = restarting || !["ready", "busy"].includes(state.textContent ?? "");
};

app.addEventListener("modulestate", ({ detail }) => {
  states.set(detail.module, detail.state);
  if (detail.state === "starting" || detail.state === "restarting")
    storages.set(detail.module, { text: "starting", reported: false });
  else if (detail.state === "ready" && !storages.get(detail.module)?.reported)
    // Writable startup has no storage event; this is a UI default, not a received state.
    storages.set(detail.module, { text: "persistent (writable)", reported: false });
  render();
});
app.addEventListener("storage", ({ detail }) => {
  storages.set(detail.module, { text: `${detail.state}: ${detail.message}`, reported: true });
  render();
});
const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
// An engine's own data downloads the first time it is made; a later selection, here or after a reload, finds it
// installed and reports nothing. Progress reaches the total only once all of it is installed.
app.addEventListener("install", ({ detail }) => {
  install.textContent =
    detail.bytes < detail.total
      ? `Installing ${detail.engine}: ${megabytes(detail.bytes)} of ${megabytes(detail.total)}`
      : `Installed ${detail.engine}: ${megabytes(detail.total)}`;
});
// Preloading an engine fetches its files, or installs them, before any selection of it; the field shows the engine's
// own progress, and what came of it once the preload settles.
app.addEventListener("preload", ({ detail }) => {
  if (detail.engine === undefined) return;
  preloadState.textContent = `Preloading ${detail.engine}: ${megabytes(detail.bytes)} of ${megabytes(detail.total)}`;
});
const preloadEngine = (install: boolean) => {
  const choice = choices[Number(preloadPicker.value)];
  if (choice === undefined) return;
  for (const button of preloadButtons) button.disabled = true;
  preloadState.textContent = `Preloading ${choice.engine}`;
  void app
    .preload([choice], { install })
    .then(
      () => {
        preloadState.textContent = `${install ? "Installed" : "Fetched"} ${choice.engine}`;
      },
      (cause: unknown) => {
        preloadState.textContent = `Not preloaded ${choice.engine}`;
        failure("Preloading failed", cause);
      },
    )
    .finally(() => {
      for (const button of preloadButtons) button.disabled = false;
    });
};
preloadButtons[0]!.addEventListener("click", () => preloadEngine(false));
preloadButtons[1]!.addEventListener("click", () => preloadEngine(true));
// A failed install ends without reaching the total, so the field would go on saying it is installing.
const switchingFailed = (cause: unknown) => {
  if (cause instanceof PrepareEngineError) install.textContent = `Not installed ${cause.engine}`;
  failure("Switching failed", cause);
};
const syncPicker = (selection: Selection | null | undefined) => {
  const index = selection
    ? choices.findIndex((choice) => choice.module === selection.module && choice.engine === selection.engine)
    : -1;
  picker.value = index < 0 ? "" : String(index);
};
app.addEventListener("selectionchange", ({ detail }) => {
  if (detail) last = detail;
  syncPicker(detail);
  render();
  if (detail && (detail.module !== shownSettings || (enginesOwnSettings && detail.engine !== shownEngine)))
    showSettings(detail.module, detail.engine);
});
app.addEventListener("panel", ({ detail }) => {
  if (detail._tag === "hide") mode.textContent = "—";
  if (detail._tag !== "record") return;
  const record = detail.record;
  const property =
    record._tag === "RegisterProperties"
      ? record.properties.properties.find((property) => property.key === "InputMode")
      : record._tag === "UpdateProperty" && record.property.key === "InputMode"
        ? record.property
        : undefined;
  if (property) mode.textContent = property.symbol.text;
});

// The focused context's registered properties, the updates it has sent for them since by key, and the context they
// belong to. The switches are drawn from both, so an update can show or hide a toggle as well as change it.
let switchContext: { readonly module: string; readonly ic: number } | undefined,
  registered: readonly Property[] = [];
const updates = new Map<string, Property>();
// The visible toggles wherever they sit in the property tree. An update without sub-properties keeps the registered
// ones.
const togglesIn = (properties: readonly Property[]): Property[] =>
  properties.flatMap((registeredProperty) => {
    const property = updates.get(registeredProperty.key) ?? registeredProperty;
    const children = property.subProps.properties.length > 0 ? property : registeredProperty;
    return [...(property.type === 1 && property.visible ? [property] : []), ...togglesIn(children.subProps.properties)];
  });
const renderSwitches = () => {
  const toggles = togglesIn(registered);
  switches.replaceChildren(
    ...toggles.map((property) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.switch = property.key;
      button.setAttribute("role", "switch");
      button.setAttribute("aria-checked", String(property.state === 1));
      button.textContent = property.label.text;
      button.title = property.tooltip.text;
      button.disabled = !property.sensitive;
      // The engine answers with UpdateProperty, which redraws the switch.
      button.addEventListener("click", () => {
        if (switchContext === undefined) return;
        app.sendPanelAction(switchContext.module, switchContext.ic, {
          _tag: "PropertyActivate",
          name: property.key,
          state: property.state === 1 ? 0 : 1,
        });
      });
      return button;
    }),
  );
  switches.hidden = toggles.length === 0;
};
// The field keeps the focus, so the action reaches the context whose switches these are.
for (const type of ["pointerdown", "mousedown"]) switches.addEventListener(type, (event) => event.preventDefault());
app.addEventListener("panel", ({ detail }) => {
  if (!ownSwitches) return;
  const ours = detail.module === switchContext?.module && detail.ic === switchContext.ic;

  // A hide for another context leaves these switches alone.
  if (detail._tag === "hide") {
    if (!ours) return;
    switchContext = undefined;
    registered = [];
    updates.clear();
    renderSwitches();
    return;
  }

  if (detail._tag !== "record") return;
  const record = detail.record;
  if (record._tag === "RegisterProperties") {
    switchContext = { module: detail.module, ic: detail.ic };
    registered = record.properties.properties;
    updates.clear();
    renderSwitches();
  } else if (record._tag === "UpdateProperty" && ours) {
    updates.set(record.property.key, record.property);
    renderSwitches();
  }
});

const toggle = () => {
  const target = app.selection ? undefined : last;
  void (target ? app.select(target.module, target.engine) : app.deselect()).catch(switchingFailed);
};
// Capturing on the window runs before the fields' own listeners, so no engine sees the shortcut.
const shortcut = (event: KeyboardEvent) => {
  if (event.code !== "Space" || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.type === "keydown" && !event.repeat) toggle();
};
window.addEventListener("keydown", shortcut, true);
window.addEventListener("keyup", shortcut, true);

picker.addEventListener("change", () => {
  const choice = picker.value === "" ? undefined : choices[Number(picker.value)];
  void (choice ? app.select(choice.module, choice.engine) : app.deselect()).catch((cause: unknown) => {
    syncPicker(app.selection);
    switchingFailed(cause);
  });
});
enabled.addEventListener("change", () => {
  if (enabled.checked) detaches = fields.map((field) => app.attach(field));
  else {
    for (const detach of detaches) detach();
    detaches = [];
  }
});
restart.addEventListener("click", () => {
  const module = current();
  if (restarting || module === undefined) return;
  restarting = true;
  render();
  void app
    .debugRestart(module)
    .catch((cause: unknown) => failure("Restart failed", cause))
    .finally(() => {
      restarting = false;
      render();
    });
});

form.closest("form")!.addEventListener("submit", (event) => event.preventDefault());
// Every module shares the panel's schema; of it, the form shows only the setting the panel reads.
const panelSchema = "org.freedesktop.ibus.panel";
const panelKeys = new Set(["lookup-table-orientation"]);
const editable = new Set(["b", "i", "s"]);
const controls: { path: string; key: SettingsKey; control: HTMLInputElement | HTMLSelectElement }[] = [];
const scalar = (value: SettingsKey["default"]) => ("value" in value ? String(value.value) : "");
const display = (control: HTMLInputElement | HTMLSelectElement, value: SettingValue) => {
  if (control instanceof HTMLInputElement && control.type === "checkbox")
    control.checked = value.value._tag === "b" && value.value.value;
  else control.value = scalar(value.value);
};
let settingsGeneration = 0,
  refreshing = false,
  disposed = false;

const refreshSettings = async () => {
  const module = shownSettings;
  if (refreshing || disposed || module === undefined) return;
  refreshing = true;
  try {
    for (const { path, key, control } of controls) {
      if (control.disabled || control === document.activeElement) continue;
      const value = await app.settings.get(module, path, key.name);
      if (!disposed && module === shownSettings && !control.disabled && control !== document.activeElement)
        display(control, value);
    }
  } finally {
    refreshing = false;
  }
};
// An engine owns the settings at the path ending in its name's components, as m17n:hi:inscript owns
// /org/freedesktop/ibus/engine/m17n/hi/inscript/ and the variables/ below it. Paths are compared in lower
// case because m17n:sa:IAST-vedic lives at .../sa/iast-vedic/.
const ownedBy = (path: string, engine: string) => {
  const segments = path.toLowerCase().split("/").filter(Boolean);
  if (segments.at(-1) === "variables") segments.pop();
  const name = engine.toLowerCase().split(":");
  return name.every((part, index) => segments.at(index - name.length) === part);
};
const loadSettings = async (module: string, engine: string, generation: number) => {
  const schemas = await app.settings.schemas(module);
  if (generation !== settingsGeneration) return;
  const engines = moduleEngines.get(module) ?? [];
  enginesOwnSettings = schemas.some((schema) =>
    schema.paths.some((path) => engines.some((other) => ownedBy(path, other))),
  );
  // Of the paths an engine owns, only the selected engine's are shown.
  const shown = (path: string) => ownedBy(path, engine) || !engines.some((other) => ownedBy(path, other));

  const ids = new Set<string>();
  for (const schema of schemas) {
    const keys = schema.keys.filter(
      (key) => editable.has(key.type) && (schema.id !== panelSchema || panelKeys.has(key.name)),
    );
    for (const path of schema.paths.filter(shown)) {
      for (const key of keys) {
        const label = document.createElement("label");
        label.className = "setting";

        const title = document.createElement("span");
        title.textContent = key.summary || key.name;

        const control = key.choices ? document.createElement("select") : document.createElement("input");
        // Key names repeat across schemas and instances; the first keeps the plain id, later ones are qualified.
        const qualified =
          schema.paths.length > 1
            ? `setting-${schema.id}-${schema.paths.indexOf(path)}-${key.name}`
            : `setting-${schema.id}-${key.name}`;
        control.id = ids.has(`setting-${key.name}`) ? qualified : `setting-${key.name}`;
        ids.add(control.id);
        control.name = key.name;

        if (control instanceof HTMLSelectElement) {
          for (const choice of key.choices!) control.add(new Option(choice, choice));
        } else {
          control.type = key.type === "b" ? "checkbox" : key.type === "i" ? "number" : "text";
          control.required = key.type === "i";
          if (key.range) {
            control.min = scalar(key.range.min);
            control.max = scalar(key.range.max);
          }
        }

        const help = document.createElement("small");
        help.id = `${control.id}-help`;
        help.textContent = `${key.description ? `${key.description} ` : ""}Default: ${scalar(key.default)}${key.range ? `; range: ${scalar(key.range.min)}–${scalar(key.range.max)}` : ""}`;
        control.setAttribute("aria-describedby", help.id);

        const value = await app.settings.get(module, path, key.name);
        if (generation !== settingsGeneration) return;
        display(control, value);
        controls.push({ path, key, control });

        control.addEventListener("change", () => {
          if (!control.reportValidity()) return;
          const value: SettingValue =
            key.type === "b"
              ? booleanVariant((control as HTMLInputElement).checked)
              : key.type === "i"
                ? int32Variant(Number(control.value))
                : stringVariant(control.value);
          control.disabled = true;
          settingsState.textContent = "Saving…";
          void app.settings.set(module, path, key.name, value).then(
            () => {
              control.disabled = false;
              settingsState.textContent = "Saved; applies live and across tabs.";
            },
            (cause: unknown) => {
              control.disabled = false;
              settingsState.textContent = "Save failed";
              failure(`Could not save ${key.name}`, cause);
              void refreshSettings().catch((cause: unknown) => failure("Settings refresh failed", cause));
            },
          );
        });

        label.append(title, control, help);
        form.append(label);
      }
    }
  }
  form.disabled = false;
  settingsState.textContent = "Settings ready; changes save automatically.";
};
const showSettings = (module: string, engine: string) => {
  shownSettings = module;
  shownEngine = engine;
  // Until the schemas say otherwise, any engine change reloads, so a switch made mid-load is not skipped.
  enginesOwnSettings = true;
  const generation = ++settingsGeneration;
  controls.length = 0;
  form.disabled = true;
  form.replaceChildren(form.querySelector("legend")!);
  settingsState.textContent = "Loading settings…";
  void loadSettings(module, engine, generation).catch((cause: unknown) => {
    if (generation !== settingsGeneration) return;
    settingsState.textContent = "Settings unavailable";
    failure("Settings initialization failed", cause);
  });
};
const refresh = () => {
  void refreshSettings().catch((cause: unknown) => {
    if (!disposed) failure("Settings refresh failed", cause);
  });
};
window.addEventListener("focus", refresh);
// The facade owns cross-tab updates; public reads also refresh visible, unfocused form controls.
const refreshTimer = setInterval(() => {
  if (document.visibilityState === "visible") refresh();
}, 1000);

const start = async () => {
  for (const module of Object.keys(modules)) {
    let engines;
    try {
      engines = await app.engines(module);
    } catch (cause) {
      failure(`Could not list ${module}`, cause);
      continue;
    }
    moduleEngines.set(
      module,
      engines.map((engine) => engine.name),
    );

    // A module whose engines span languages gets a group per language, in the order its manifest first lists each.
    const byLanguage = new Set(engines.map((engine) => languageOf(engine.languages[0]))).size > 1;
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const engine of engines) {
      const language = byLanguage ? languageOf(engine.languages[0]) : "";
      let group = groups.get(language);
      if (group === undefined) {
        group = document.createElement("optgroup");
        group.label = language === "" ? module : `${module} · ${languageName(language)}`;
        groups.set(language, group);
        picker.append(group);
      }
      const option = new Option(engine.displayName, String(choices.length));
      option.dataset.engine = engine.name;
      group.append(option);
      choices.push({ module, engine: engine.name });
    }
  }
  const first = choices[0];
  if (!first) throw new Error("No module could be loaded");
  for (const group of picker.querySelectorAll("optgroup")) preloadPicker.append(group.cloneNode(true));
  picker.disabled = false;
  preloadPicker.disabled = false;
  for (const button of preloadButtons) button.disabled = false;
  showSettings(first.module, first.engine);
  await app.select(first.module, first.engine);
  enabled.disabled = false;
};
void start().catch((cause: unknown) => failure("Engine initialization failed", cause));

const dispose = () => {
  disposed = true;
  clearInterval(refreshTimer);
  window.removeEventListener("focus", refresh);
  window.removeEventListener("keydown", shortcut, true);
  window.removeEventListener("keyup", shortcut, true);
  panel.dispose();
  void app.dispose().catch((cause: unknown) => failure("Cleanup failed", cause));
};
window.addEventListener("pagehide", dispose, { once: true });
if (import.meta.hot) import.meta.hot.dispose(dispose);
