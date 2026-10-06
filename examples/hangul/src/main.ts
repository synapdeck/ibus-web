// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { createIbusWeb, type IbusWeb, type LogEntry } from "ibus-web";
import { createPanel } from "ibus-web/panel";
import "ibus-web/panel/style.css";
import "./style.css";

type SettingsKey = Awaited<ReturnType<IbusWeb["settings"]["schemas"]>>[number]["keys"][number];
type SettingValue = Awaited<ReturnType<IbusWeb["settings"]["get"]>>;
const query = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const fields = [query<HTMLTextAreaElement>("#input"), query<HTMLInputElement>("#single-line")];
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
const app = createIbusWeb({
  hostUrl: new URL("/ibus-web/host/worker/index.js", location.href),
  runtimeUrl: new URL("/ibus-web/runtime/ibus-runtime.js", location.href),
  engines: { hangul: new URL("/ibus-web/hangul/manifest.json", location.href) },
  logger,
});
const panel = createPanel(app);
let detaches = fields.map((field) => app.attach(field));
let storageReported = false;
app.addEventListener("enginestate", ({ detail }) => {
  state.textContent = detail.state;
  restart.disabled = detail.state !== "ready";
  if (detail.state === "starting" || detail.state === "restarting") {
    storageReported = false;
    storage.textContent = "starting";
  } else if (detail.state === "ready" && !storageReported) {
    // Writable startup has no storage event; this is a UI default, not a received state.
    storage.textContent = "persistent (writable)";
  }
});
app.addEventListener("storage", ({ detail }) => {
  storageReported = true;
  storage.textContent = `${detail.state}: ${detail.message}`;
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
enabled.addEventListener("change", () => {
  if (enabled.checked) detaches = fields.map((field) => app.attach(field));
  else {
    for (const detach of detaches) detach();
    detaches = [];
  }
});
restart.addEventListener("click", () => {
  restart.disabled = true;
  void app.debugRestart("hangul").catch((cause: unknown) => failure("Restart failed", cause));
});

form.closest("form")!.addEventListener("submit", (event) => event.preventDefault());
const requested = new Set([
  "hangul-keyboard",
  "hanja-keys",
  "initial-input-mode",
  "auto-reorder",
  "preedit-mode",
  "lookup-table-orientation",
]);
const controls: { schema: string; key: SettingsKey; control: HTMLInputElement | HTMLSelectElement }[] = [];
const scalar = (value: SettingsKey["default"]) => ("value" in value ? String(value.value) : "");
const display = (control: HTMLInputElement | HTMLSelectElement, value: SettingValue) => {
  if (control instanceof HTMLInputElement && control.type === "checkbox")
    control.checked = value.value._tag === "b" && value.value.value;
  else control.value = scalar(value.value);
};
let refreshing = false,
  disposed = false;
const refreshSettings = async () => {
  if (refreshing || disposed) return;
  refreshing = true;
  try {
    for (const { schema, key, control } of controls) {
      if (control.disabled || control === document.activeElement) continue;
      const value = await app.settings.get("hangul", schema, key.name);
      if (!disposed && !control.disabled && control !== document.activeElement) display(control, value);
    }
  } finally {
    refreshing = false;
  }
};
const loadSettings = async () => {
  const schemas = await app.settings.schemas("hangul");
  for (const schema of schemas) {
    for (const key of schema.keys.filter((key) => requested.has(key.name))) {
      const label = document.createElement("label");
      label.className = "setting";
      const title = document.createElement("span");
      title.textContent = key.summary || key.name;
      const control = key.choices ? document.createElement("select") : document.createElement("input");
      control.id = `setting-${key.name}`;
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
      display(control, await app.settings.get("hangul", schema.id, key.name));
      controls.push({ schema: schema.id, key, control });
      control.addEventListener("change", () => {
        if (!control.reportValidity()) return;
        const value: SettingValue = {
          _tag: "v",
          type: key.type,
          value:
            key.type === "b"
              ? { _tag: "b", value: (control as HTMLInputElement).checked }
              : key.type === "i"
                ? { _tag: "i", value: Number(control.value) }
                : { _tag: "s", value: control.value },
        };
        control.disabled = true;
        settingsState.textContent = "Saving…";
        void app.settings.set("hangul", schema.id, key.name, value).then(
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
void loadSettings().catch((cause: unknown) => {
  settingsState.textContent = "Settings unavailable";
  failure("Settings initialization failed", cause);
});
void app.select("hangul").then(
  () => (enabled.disabled = false),
  (cause: unknown) => failure("Engine initialization failed", cause),
);
const dispose = () => {
  disposed = true;
  clearInterval(refreshTimer);
  window.removeEventListener("focus", refresh);
  panel.dispose();
  void app.dispose().catch((cause: unknown) => failure("Cleanup failed", cause));
};
window.addEventListener("pagehide", dispose, { once: true });
if (import.meta.hot) import.meta.hot.dispose(dispose);
