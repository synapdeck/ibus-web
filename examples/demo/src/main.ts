// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  booleanVariant,
  createIbusWeb,
  int32Variant,
  stringVariant,
  type IbusWeb,
  type LogEntry,
  type Selection,
} from "ibus-web";
import { createPanel } from "ibus-web/panel";
import "ibus-web/panel/style.css";
import "./style.css";

type SettingsKey = Awaited<ReturnType<IbusWeb["settings"]["schemas"]>>[number]["keys"][number];
type SettingValue = Awaited<ReturnType<IbusWeb["settings"]["get"]>>;

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

const modules = await loadModules();
const app = createIbusWeb({
  hostUrl: new URL("/ibus-web/host/worker/index.js", location.href),
  runtimeUrl: new URL("/ibus-web/runtime/ibus-runtime.js", location.href),
  modules,
  logger,
});
const panel = createPanel(app);
let detaches = fields.map((field) => app.attach(field));

// Every engine of every module, in manifest order; the picker's option values index it.
const choices: Selection[] = [];
let last: Selection | undefined,
  shownSettings: string | undefined,
  restarting = false;
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
  if (detail && detail.module !== shownSettings) showSettings(detail.module);
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

const toggle = () => {
  const target = app.selection ? undefined : last;
  void (target ? app.select(target.module, target.engine) : app.deselect()).catch((cause: unknown) =>
    failure("Switching failed", cause),
  );
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
    failure("Switching failed", cause);
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
const controls: { schema: string; key: SettingsKey; control: HTMLInputElement | HTMLSelectElement }[] = [];
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
    for (const { schema, key, control } of controls) {
      if (control.disabled || control === document.activeElement) continue;
      const value = await app.settings.get(module, schema, key.name);
      if (!disposed && module === shownSettings && !control.disabled && control !== document.activeElement)
        display(control, value);
    }
  } finally {
    refreshing = false;
  }
};
const loadSettings = async (module: string, generation: number) => {
  const schemas = await app.settings.schemas(module);
  const ids = new Set<string>();
  for (const schema of schemas) {
    const keys = schema.keys.filter(
      (key) => editable.has(key.type) && (schema.id !== panelSchema || panelKeys.has(key.name)),
    );
    for (const key of keys) {
      const label = document.createElement("label");
      label.className = "setting";
      const title = document.createElement("span");
      title.textContent = key.summary || key.name;
      const control = key.choices ? document.createElement("select") : document.createElement("input");
      // Key names repeat across schemas; the first keeps the plain id, later ones are qualified.
      control.id = ids.has(`setting-${key.name}`) ? `setting-${schema.id}-${key.name}` : `setting-${key.name}`;
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
      const value = await app.settings.get(module, schema.id, key.name);
      if (generation !== settingsGeneration) return;
      display(control, value);
      controls.push({ schema: schema.id, key, control });
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
        void app.settings.set(module, schema.id, key.name, value).then(
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
  form.disabled = false;
  settingsState.textContent = "Settings ready; changes save automatically.";
};
const showSettings = (module: string) => {
  shownSettings = module;
  const generation = ++settingsGeneration;
  controls.length = 0;
  form.disabled = true;
  form.replaceChildren(form.querySelector("legend")!);
  settingsState.textContent = "Loading settings…";
  void loadSettings(module, generation).catch((cause: unknown) => {
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
    const group = document.createElement("optgroup");
    group.label = module;
    for (const engine of await app.engines(module)) {
      group.append(new Option(engine.displayName, String(choices.length)));
      choices.push({ module, engine: engine.name });
    }
    picker.append(group);
  }
  const first = choices[0];
  if (!first) throw new Error("No modules are configured");
  picker.disabled = false;
  showSettings(first.module);
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
