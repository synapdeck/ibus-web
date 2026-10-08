// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { ProtocolError, type IBusProperty, type IBusText, type LazyLookupTable } from "@ibus-web/protocol";
import { createPanel, type PanelHost, type PanelRecord, type PanelUpdate } from "../../src/index.ts";
import "../../src/style.css";

const text = (value: string): IBusText => ({
  attachments: {},
  text: value,
  attrs: { attachments: {}, attributes: [] },
});
const property = (key: string, overrides: Partial<IBusProperty> = {}): IBusProperty => ({
  attachments: {},
  key,
  type: 1,
  label: text(key),
  icon: "",
  tooltip: text(""),
  sensitive: true,
  visible: true,
  state: 0,
  subProps: { attachments: {}, properties: [] },
  symbol: text(""),
  ...overrides,
});
class Host extends EventTarget implements PanelHost {
  rect = { x: 40, y: 40, width: 2, height: 20 };
  orientation: 0 | 1 = 1;
  caretRect = () => this.rect;
  lookupTableOrientation = vi.fn((_engine: string) => this.orientation);
  sendPanelAction = vi.fn<PanelHost["sendPanelAction"]>();
  reportPanelError = vi.fn();
  emit(detail: PanelUpdate) {
    this.dispatchEvent(new CustomEvent("panel", { detail }));
  }
  record(record: PanelRecord, ic = 1) {
    this.emit({ _tag: "record", module: "test", ic, record });
  }
  notify(_tag: "hide" | "caret" | "orientation", ic = 1) {
    this.emit({ _tag, module: "test", ic });
  }
}
function table(overrides: Partial<LazyLookupTable> = {}) {
  const page = vi.fn((index: number) => ({
    candidates: Array.from({ length: 3 }, (_, i) => text(`candidate-${index * 3 + i}`)),
    labels: [text("A"), text("B")],
  }));
  const result: LazyLookupTable = {
    pageSize: 3,
    cursorPos: 4,
    cursorVisible: true,
    count: 9,
    round: false,
    orientation: 1,
    page,
    visible: () => result.page(Math.floor(result.cursorPos / result.pageSize)),
    ...overrides,
  };
  return { table: result, page };
}
const dispose: (() => void)[] = [];
afterEach(() => {
  dispose.splice(0).forEach((fn) => fn());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function setup() {
  const host = new Host();
  const panel = createPanel(host);
  dispose.push(panel.dispose);
  return { host, ...panel };
}
function show(host: Host, value = table().table, visible = true) {
  host.record({ _tag: "UpdateLookupTable", table: value, visible });
}
function buttons(element: HTMLElement) {
  return [...element.querySelectorAll<HTMLButtonElement>("[data-candidate]")];
}
function click(element: HTMLElement, selector: string) {
  element.querySelector<HTMLElement>(selector)!.click();
}

test("shows only the visible page, supplied and fallback labels, and the visible cursor", () => {
  const { host, element } = setup();
  const lazy = table();
  show(host, lazy.table);
  expect(element.hidden).toBe(false);
  expect(buttons(element).map((b) => b.textContent)).toEqual(["A candidate-3", "B candidate-4", "3. candidate-5"]);
  expect(element.querySelector('[aria-selected="true"]')?.textContent).toBe("B candidate-4");
  expect(lazy.page.mock.calls).toEqual([[1]]);
  show(host, table({ cursorVisible: false }).table);
  expect(element.querySelector('[aria-selected="true"]')).toBeNull();
});
test("defers hidden lookup decoding and decodes the next page only when the engine shows it", () => {
  const { host, element } = setup();
  const lazy = table();
  show(host, lazy.table, false);
  expect(lazy.page).not.toHaveBeenCalled();
  host.record({ _tag: "ShowLookupTable" });
  expect(lazy.page.mock.calls).toEqual([[1]]);
  click(element, '[data-action="next"]');
  expect(lazy.page).toHaveBeenCalledTimes(1);
  const next = table({ cursorPos: 7 });
  show(host, next.table);
  expect(next.page.mock.calls).toEqual([[2]]);
  expect(buttons(element)[1].textContent).toBe("B candidate-7");
});
test("sends page-relative selection, paging and directional wheel actions", () => {
  const { host, element } = setup();
  show(host);
  buttons(element)[2].click();
  click(element, '[data-action="previous"]');
  click(element, '[data-action="next"]');
  element.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, cancelable: true }));
  element.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, cancelable: true }));
  element.dispatchEvent(new WheelEvent("wheel", { deltaY: 0, cancelable: true }));
  expect(host.sendPanelAction.mock.calls).toEqual([
    ["test", 1, { _tag: "CandidateClicked", index: 2, button: 1, state: 0 }],
    ["test", 1, { _tag: "PageUp" }],
    ["test", 1, { _tag: "PageDown" }],
    ["test", 1, { _tag: "CursorUp" }],
    ["test", 1, { _tag: "CursorDown" }],
  ]);
});
test("resolves System orientation from the engine setting and follows changes without decoding again", () => {
  const { host, element } = setup();
  const lazy = table({ orientation: 2 });
  show(host, lazy.table);
  expect(element.dataset.orientation).toBe("vertical");
  host.orientation = 0;
  host.notify("orientation");
  expect(element.dataset.orientation).toBe("horizontal");
  expect(host.lookupTableOrientation).toHaveBeenCalledWith("test");
  expect(lazy.page).toHaveBeenCalledTimes(1);
  show(host, table({ orientation: 1 }).table);
  expect(element.dataset.orientation).toBe("vertical");
  show(host, table({ orientation: 0 }).table);
  expect(element.dataset.orientation).toBe("horizontal");
});
test("anchors below or above the caret and clamps both viewport edges", () => {
  const { host, element } = setup();
  show(host);
  expect(element.getBoundingClientRect().top).toBeCloseTo(60, 0);
  host.rect = { x: innerWidth - 1, y: innerHeight - 2, width: 2, height: 2 };
  host.notify("caret");
  let bounds = element.getBoundingClientRect();
  expect(bounds.bottom).toBeLessThanOrEqual(host.rect.y + 1);
  expect(bounds.right).toBeLessThanOrEqual(innerWidth + 1);
  host.rect = { x: -100, y: -100, width: 2, height: 2 };
  host.notify("caret");
  bounds = element.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
});
test("renders auxiliary text independently of the table and respects show/hide records", () => {
  const { host, element } = setup();
  host.record({ _tag: "UpdateAuxiliaryText", text: text("help <b>safe</b>"), visible: true });
  expect(element.querySelector("[data-auxiliary]")?.textContent).toBe("help <b>safe</b>");
  expect(element.querySelector("b")).toBeNull();
  host.record({ _tag: "HideAuxiliaryText" });
  expect(element.hidden).toBe(true);
  host.record({ _tag: "ShowAuxiliaryText" });
  expect(element.hidden).toBe(false);
  show(host);
  host.record({ _tag: "HideLookupTable" });
  expect(buttons(element)).toHaveLength(0);
  expect(element.hidden).toBe(false);
});
test("lists visible nested properties, reflects toggles and radios and uses the first eligible symbol", () => {
  const { host, element } = setup();
  host.record({
    _tag: "RegisterProperties",
    properties: {
      attachments: {},
      properties: [
        property("hidden", { visible: false, symbol: text("NO") }),
        property("normal", { type: 0, symbol: text("ignored") }),
        property("menu", {
          type: 3,
          subProps: { attachments: {}, properties: [property("mode", { type: 2, state: 1, symbol: text("한") })] },
        }),
        property("toggle", { symbol: text("EN") }),
        property("disabled", { sensitive: false }),
      ],
    },
  });
  expect(element.querySelector("[data-indicator]")?.textContent).toBe("한");
  expect(element.textContent).not.toContain("hidden");
  expect(element.querySelector('[data-property="mode"]')?.getAttribute("aria-checked")).toBe("true");
  click(element, '[data-property="mode"]');
  expect(host.sendPanelAction).not.toHaveBeenCalled();
  click(element, '[data-property="toggle"]');
  expect(host.sendPanelAction).toHaveBeenLastCalledWith("test", 1, {
    _tag: "PropertyActivate",
    name: "toggle",
    state: 1,
  });
  click(element, '[data-property="toggle"]');
  expect(host.sendPanelAction).toHaveBeenLastCalledWith("test", 1, {
    _tag: "PropertyActivate",
    name: "toggle",
    state: 0,
  });
  click(element, '[data-property="disabled"]');
  expect(host.sendPanelAction).toHaveBeenCalledTimes(2);
  host.record({ _tag: "UpdateProperty", property: property("mode", { type: 2, visible: false }) });
  expect(element.querySelector("[data-indicator]")?.textContent).toBe("EN");
});
test("suppresses duplicate radio activation until an authoritative property update", () => {
  const { host, element } = setup();
  host.record({
    _tag: "RegisterProperties",
    properties: { attachments: {}, properties: [property("radio", { type: 2 })] },
  });
  click(element, '[data-property="radio"]');
  click(element, '[data-property="radio"]');
  expect(host.sendPanelAction).toHaveBeenCalledTimes(1);
  host.record({ _tag: "UpdateProperty", property: property("radio", { type: 2, state: 0 }) });
  click(element, '[data-property="radio"]');
  expect(host.sendPanelAction).toHaveBeenCalledTimes(2);
});
test("clears output on FocusOut/crash hides and does not revive stale output", () => {
  const { host, element } = setup();
  show(host);
  host.notify("hide");
  expect(element.hidden).toBe(true);
  host.record({ _tag: "ShowLookupTable" });
  expect(element.hidden).toBe(true);
  show(host);
  host.notify("hide");
  expect(element.hidden).toBe(true);
});
test("ignores stale hide/geometry events from a different context and clears on a context switch", () => {
  const { host, element } = setup();
  show(host);
  host.notify("hide", 2);
  expect(element.hidden).toBe(false);
  host.record({ _tag: "UpdateAuxiliaryText", text: text("new context"), visible: true }, 2);
  expect(buttons(element)).toHaveLength(0);
  expect(element.textContent).toContain("new context");
});
test("reports a malformed newly visible page and callback errors without EventTarget exceptions", () => {
  const { host, element } = setup();
  const error = new ProtocolError({ message: "bad deferred text" });
  const lazy = table({
    visible: () => {
      throw error;
    },
  });
  show(host, lazy.table, false);
  expect(host.reportPanelError).not.toHaveBeenCalled();
  host.record({ _tag: "ShowLookupTable" });
  expect(host.reportPanelError).toHaveBeenCalledWith(error);
  expect(element.hidden).toBe(true);
  show(host);
  const actionError = new Error("closed host");
  host.sendPanelAction.mockImplementation(() => {
    throw actionError;
  });
  buttons(element)[0].click();
  expect(host.reportPanelError).toHaveBeenCalledWith(actionError);
  expect(element.hidden).toBe(true);
});
test("preserves the composing field's focus, value and selection during trusted candidate/control clicks", async () => {
  const input = document.createElement("textarea");
  input.value = "composition";
  document.body.append(input);
  input.focus();
  input.setSelectionRange(3, 3);
  const blur = vi.fn();
  input.addEventListener("blur", blur);
  const { host, element } = setup();
  host.rect = { x: 300, y: 100, width: 2, height: 20 };
  show(host);
  await userEvent.click(buttons(element)[0]);
  await userEvent.click(element.querySelector('[data-action="next"]')!);
  host.record({ _tag: "RegisterProperties", properties: { attachments: {}, properties: [property("mode")] } });
  await userEvent.click(element.querySelector('[data-property="mode"]')!);
  expect(document.activeElement).toBe(input);
  expect(blur).not.toHaveBeenCalled();
  expect(input.value).toBe("composition");
  expect(input.selectionStart).toBe(3);
});
test("disposes listeners and DOM and allows host CSS custom properties", () => {
  const { host, element, dispose } = setup();
  element.style.setProperty("--ibus-panel-background", "rgb(1, 2, 3)");
  show(host);
  expect(getComputedStyle(element).backgroundColor).toBe("rgb(1, 2, 3)");
  dispose();
  show(host);
  expect(element.isConnected).toBe(false);
});
test("disables nested menu actions", () => {
  const { host, element } = setup();
  host.record({
    _tag: "RegisterProperties",
    properties: {
      attachments: {},
      properties: [
        property("menu", { type: 3, sensitive: false, subProps: { attachments: {}, properties: [property("child")] } }),
      ],
    },
  });
  expect(element.querySelector<HTMLButtonElement>('[data-property="child"]')!.disabled).toBe(true);
});
test("guards property callback failures and hides paging when no table exists", () => {
  const { host, element } = setup();
  host.record({ _tag: "RegisterProperties", properties: { attachments: {}, properties: [property("toggle")] } });
  expect.soft(element.querySelector<HTMLElement>('[data-action="next"]')!.parentElement!.hidden).toBe(true);
  const failure = new Error("property host closed");
  host.sendPanelAction.mockImplementation(() => {
    throw failure;
  });
  click(element, '[data-property="toggle"]');
  expect(host.reportPanelError).toHaveBeenCalledWith(failure);
  expect(element.hidden).toBe(true);
});
test("uses all sixteen fallback labels and shows at most one selected radio per group", () => {
  const { host, element } = setup();
  show(
    host,
    table({
      pageSize: 16,
      cursorPos: 0,
      visible: () => ({ candidates: Array.from({ length: 16 }, () => text("x")), labels: [] }),
    }).table,
  );
  expect(buttons(element).map((b) => b.textContent)).toEqual([..."1234567890abcdef"].map((label) => `${label}. x`));
  host.record({
    _tag: "RegisterProperties",
    properties: {
      attachments: {},
      properties: [property("radio1", { type: 2, state: 1 }), property("radio2", { type: 2 })],
    },
  });
  click(element, '[data-property="radio2"]');
  expect(element.querySelector('[data-property="radio1"]')!.getAttribute("aria-checked")).toBe("false");
  expect(element.querySelector('[data-property="radio2"]')!.getAttribute("aria-checked")).toBe("true");
});
test.each([0, 1, 3, 4])("preserves separate radio groups across non-radio type %i", (type) => {
  const { host, element } = setup();
  host.record({
    _tag: "RegisterProperties",
    properties: {
      attachments: {},
      properties: [
        property("A", { type: 2, state: 1 }),
        property("B", { type: 2 }),
        property("boundary", { type }),
        property("C", { type: 2, state: 1 }),
        property("D", { type: 2 }),
      ],
    },
  });
  click(element, '[data-property="B"]');
  expect(element.querySelector('[data-property="A"]')!.getAttribute("aria-checked")).toBe("false");
  expect(element.querySelector('[data-property="B"]')!.getAttribute("aria-checked")).toBe("true");
  expect.soft(element.querySelector('[data-property="C"]')!.getAttribute("aria-checked")).toBe("true");
  expect(element.querySelector('[data-property="D"]')!.getAttribute("aria-checked")).toBe("false");
  click(element, '[data-property="C"]');
  expect(host.sendPanelAction.mock.calls).toEqual([["test", 1, { _tag: "PropertyActivate", name: "B", state: 1 }]]);
});
test("keeps nested radio groups independent from parent and separated nested groups", () => {
  const { host, element } = setup();
  host.record({
    _tag: "RegisterProperties",
    properties: {
      attachments: {},
      properties: [
        property("parent", { type: 2, state: 1 }),
        property("menu", {
          type: 3,
          subProps: {
            attachments: {},
            properties: [
              property("A", { type: 2, state: 1 }),
              property("B", { type: 2 }),
              property("boundary", { type: 4 }),
              property("C", { type: 2, state: 1 }),
              property("D", { type: 2 }),
            ],
          },
        }),
      ],
    },
  });
  click(element, '[data-property="B"]');
  expect(element.querySelector('[data-property="A"]')!.getAttribute("aria-checked")).toBe("false");
  expect(element.querySelector('[data-property="B"]')!.getAttribute("aria-checked")).toBe("true");
  expect(element.querySelector('[data-property="parent"]')!.getAttribute("aria-checked")).toBe("true");
  expect.soft(element.querySelector('[data-property="C"]')!.getAttribute("aria-checked")).toBe("true");
  click(element, '[data-property="C"]');
  expect(host.sendPanelAction.mock.calls).toEqual([["test", 1, { _tag: "PropertyActivate", name: "B", state: 1 }]]);
});
test("defers resize feedback to one frame and cancels pending placement on disposal", () => {
  let notify!: () => void;
  vi.spyOn(globalThis, "ResizeObserver").mockImplementation(
    class {
      constructor(callback: ResizeObserverCallback) {
        notify = () => callback([], this);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let frame!: FrameRequestCallback;
  const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frame = callback;
    return 123;
  });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const { host, element, dispose: close } = setup();
  show(host);
  const initial = element.style.left;
  host.rect.x = 100;
  notify();
  notify();
  expect(element.style.left).toBe(initial);
  expect(request).toHaveBeenCalledTimes(1);
  frame(0);
  expect(element.style.left).toBe("100px");
  host.rect.x = 120;
  host.notify("caret");
  expect(element.style.left).toBe("120px");
  notify();
  close();
  expect(cancel).toHaveBeenCalledWith(123);
  frame(0);
  expect(element.isConnected).toBe(false);
});
