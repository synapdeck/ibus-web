// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { IBusProperty } from "@ibus-web/protocol";
import type { PanelAction } from "./host.ts";

export function replaceProperty(
  properties: readonly IBusProperty[],
  update: IBusProperty,
  activate = false,
): readonly IBusProperty[] {
  const selected =
    activate && update.type === 2 && update.state === 1
      ? properties.findIndex((property) => property.key === update.key)
      : -1;
  let groupStart = selected,
    groupEnd = selected;
  if (selected !== -1) {
    // Every non-radio property separates groups, regardless of its visibility.
    while (groupStart > 0 && properties[groupStart - 1].type === 2) groupStart--;
    while (groupEnd + 1 < properties.length && properties[groupEnd + 1].type === 2) groupEnd++;
  }
  return properties.map((property, index) =>
    property.key === update.key
      ? update
      : {
          ...property,
          ...(index >= groupStart && index <= groupEnd && property.type === 2 ? { state: 0 } : {}),
          subProps: {
            ...property.subProps,
            properties: replaceProperty(property.subProps.properties, update, activate),
          },
        },
  );
}
export function propertyIndicator(properties: readonly IBusProperty[]): string {
  for (const property of properties) {
    if (!property.visible) continue;
    if ((property.type === 1 || property.type === 2) && property.symbol.text) return property.symbol.text;
    const nested = propertyIndicator(property.subProps.properties);
    if (nested) return nested;
  }
  return "";
}

export function renderProperties(
  parent: HTMLElement,
  properties: readonly IBusProperty[],
  send: (action: PanelAction) => void,
  change: (property: IBusProperty) => void,
  guard: (run: () => void) => void,
  enabled = true,
): void {
  parent.replaceChildren();
  for (const property of properties) {
    if (!property.visible) continue;
    if (property.type === 4) {
      const separator = document.createElement("hr");
      separator.setAttribute("role", "separator");
      parent.append(separator);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.property = property.key;
    button.textContent = property.label.text;
    button.title = property.tooltip.text;
    button.disabled = !property.sensitive || !enabled;
    const checkable = property.type === 1 || property.type === 2;
    button.setAttribute(
      "role",
      property.type === 1 ? "menuitemcheckbox" : property.type === 2 ? "menuitemradio" : "menuitem",
    );
    if (checkable) button.setAttribute("aria-checked", property.state === 2 ? "mixed" : String(property.state === 1));
    parent.append(button);
    if (property.type === 3) {
      const group = document.createElement("div");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", property.label.text);
      parent.append(group);
      renderProperties(group, property.subProps.properties, send, change, guard, enabled && property.sensitive);
      continue;
    }
    button.addEventListener("click", () =>
      guard(() => {
        const state = property.type === 1 ? (property.state === 1 ? 0 : 1) : property.type === 2 ? 1 : property.state;
        if (checkable && state === property.state) return;
        send({ _tag: "PropertyActivate", name: property.key, state });
        if (checkable) change({ ...property, state });
      }),
    );
  }
}
