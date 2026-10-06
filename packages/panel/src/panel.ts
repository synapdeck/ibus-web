// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { IBusProperty, LazyLookupTable, LookupPage } from "@ibus-web/protocol";
import type { PanelAction, PanelHost, PanelRecord, PanelUpdate } from "./host.ts";
import { propertyIndicator, renderProperties, replaceProperty } from "./properties.ts";

export interface Panel {
  readonly element: HTMLDivElement;
  dispose(): void;
}

/** Mount a panel. Import @ibus-web/panel/style.css to apply its overridable default theme. */
export function createPanel(host: PanelHost): Panel {
  const element = document.createElement("div");
  element.className = "ibus-panel";
  element.hidden = true;
  element.setAttribute("aria-label", "Input method");
  const auxiliary = document.createElement("div");
  auxiliary.dataset.auxiliary = "";
  const candidates = document.createElement("div");
  candidates.className = "ibus-panel-candidates";
  candidates.setAttribute("role", "listbox");
  candidates.setAttribute("aria-label", "Candidates");
  const navigation = document.createElement("div");
  navigation.className = "ibus-panel-navigation";
  const indicator = document.createElement("span");
  indicator.dataset.indicator = "";
  const propertiesMenu = document.createElement("div");
  propertiesMenu.setAttribute("role", "menu");
  propertiesMenu.setAttribute("aria-label", "Input method properties");
  element.append(auxiliary, candidates, navigation, indicator, propertiesMenu);
  document.body.append(element);
  let context: { readonly engine: string; readonly ic: number } | undefined;
  let table: LazyLookupTable | undefined;
  let page: LookupPage | undefined;
  let tableVisible = false,
    auxiliaryVisible = false,
    disposed = false;
  let properties: readonly IBusProperty[] = [];

  const clear = () => {
    table = undefined;
    page = undefined;
    properties = [];
    tableVisible = auxiliaryVisible = false;
    candidates.replaceChildren();
    propertiesMenu.replaceChildren();
    auxiliary.textContent = "";
    indicator.textContent = "";
    element.hidden = true;
    auxiliary.hidden = candidates.hidden = navigation.hidden = propertiesMenu.hidden = indicator.hidden = true;
  };
  // EventTarget does not deliver listener exceptions to dispatchEvent's caller.
  const guard = (run: () => void) => {
    if (disposed) return;
    try {
      run();
    } catch (error) {
      clear();
      host.reportPanelError(error);
    }
  };
  const send = (action: PanelAction) => {
    if (context) host.sendPanelAction(context.engine, context.ic, action);
  };
  const place = () => {
    const rect = host.caretRect();
    element.hidden = !rect || !((tableVisible && table) || auxiliaryVisible || propertiesMenu.childElementCount);
    if (element.hidden || !rect) return;
    const bounds = element.getBoundingClientRect();
    const below = rect.y + rect.height;
    const top = below + bounds.height <= innerHeight ? below : rect.y - bounds.height;
    element.style.left = `${Math.max(0, Math.min(rect.x, innerWidth - bounds.width))}px`;
    element.style.top = `${Math.max(0, Math.min(top, innerHeight - bounds.height))}px`;
  };
  const orient = () => {
    const orientation =
      table?.orientation === 2 && context ? host.lookupTableOrientation(context.engine) : table?.orientation;
    element.dataset.orientation = orientation === 0 ? "horizontal" : "vertical";
  };
  const drawProperties = () => {
    renderProperties(
      propertiesMenu,
      properties,
      send,
      (update) => {
        properties = replaceProperty(properties, update, true);
        drawProperties();
        place();
      },
      guard,
    );
    indicator.textContent = propertyIndicator(properties);
    indicator.hidden = !indicator.textContent;
    propertiesMenu.hidden = !propertiesMenu.childElementCount;
  };
  const drawTable = () => {
    candidates.replaceChildren();
    candidates.hidden = navigation.hidden = !(tableVisible && table);
    if (!tableVisible || !table) return;
    page ??= table.visible();
    const cursor = table.pageSize ? table.cursorPos % table.pageSize : -1;
    page.candidates.forEach((candidate, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.candidate = String(index);
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(table!.cursorVisible && cursor === index));
      const fallback = `${"1234567890abcdef"[index] ?? index + 1}.`;
      button.textContent = `${page!.labels[index]?.text ?? fallback} ${candidate.text}`;
      button.addEventListener("click", (event) =>
        guard(() => {
          if (event.button === 0) send({ _tag: "CandidateClicked", index, button: 1, state: 0 });
        }),
      );
      candidates.append(button);
    });
  };
  const apply = (record: PanelRecord) => {
    switch (record._tag) {
      case "UpdateLookupTable":
        table = record.table;
        page = undefined;
        tableVisible = record.visible;
        drawTable();
        orient();
        break;
      case "ShowLookupTable":
        tableVisible = true;
        drawTable();
        break;
      case "HideLookupTable":
        tableVisible = false;
        drawTable();
        break;
      case "UpdateAuxiliaryText":
        auxiliary.textContent = record.text.text;
        auxiliaryVisible = record.visible;
        break;
      case "ShowAuxiliaryText":
        auxiliaryVisible = Boolean(auxiliary.textContent);
        break;
      case "HideAuxiliaryText":
        auxiliaryVisible = false;
        break;
      case "RegisterProperties":
        properties = record.properties.properties;
        drawProperties();
        break;
      case "UpdateProperty":
        properties = replaceProperty(properties, record.property);
        drawProperties();
        break;
    }
    auxiliary.hidden = !auxiliaryVisible;
    place();
  };
  const receive = (event: Event) =>
    guard(() => {
      const update = (event as CustomEvent<PanelUpdate>).detail;
      const same = context?.engine === update.engine && context.ic === update.ic;
      if (update._tag !== "record") {
        if (!same) return;
        if (update._tag === "hide") {
          clear();
          context = undefined;
        } else if (update._tag === "orientation") {
          orient();
          place();
        } else place();
        return;
      }
      if (!same) {
        clear();
        context = { engine: update.engine, ic: update.ic };
      }
      apply(update.record);
    });
  for (const [action, label, tag] of [
    ["previous", "Previous page", "PageUp"],
    ["next", "Next page", "PageDown"],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    button.textContent = label;
    button.addEventListener("click", () => guard(() => send({ _tag: tag })));
    navigation.append(button);
  }
  // Cancel the focus-changing default before it can end the field's composition.
  element.addEventListener("pointerdown", (event) => event.preventDefault());
  element.addEventListener("mousedown", (event) => event.preventDefault());
  element.addEventListener(
    "wheel",
    (event) =>
      guard(() => {
        if (!tableVisible || !table || !event.deltaY) return;
        event.preventDefault();
        send({ _tag: event.deltaY < 0 ? "CursorUp" : "CursorDown" });
      }),
    { passive: false },
  );
  const relocate = () => guard(place);
  const observer = new ResizeObserver(relocate);
  observer.observe(element);
  host.addEventListener("panel", receive);
  window.addEventListener("resize", relocate);
  window.addEventListener("scroll", relocate, true);
  return {
    element,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      host.removeEventListener("panel", receive);
      window.removeEventListener("resize", relocate);
      window.removeEventListener("scroll", relocate, true);
      clear();
      element.remove();
    },
  };
}
