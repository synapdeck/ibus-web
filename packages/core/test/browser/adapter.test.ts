// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { textareaAdapter } from "../../src/adapters/textarea.ts";
import { run, select, key, preedit } from "./support/dom.ts";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function field(tag: "input" | "textarea" = "textarea", value = "ab😀cd") {
  const element = document.createElement(tag);
  element.style.cssText =
    "position:fixed;left:40px;top:40px;width:250px;height:100px;padding:8px;border:2px solid;font:20px/24px monospace;box-sizing:border-box";
  element.value = value;
  document.body.append(element);
  element.focus();
  element.setSelectionRange(value.length, value.length);
  const onPreedit = vi.fn();
  const adapter = textareaAdapter(element, { onPreedit });
  const reset = vi.fn();
  cleanup.push(adapter.onReset(reset));
  return { element, adapter, reset, onPreedit };
}
test("decorates UTF-16 ranges without value, input events or history", () => {
  const { element, adapter, onPreedit } = field();
  const input = vi.fn();
  element.addEventListener("input", input);
  adapter.setPreedit({
    text: "😀한",
    cursor: 3,
    attributes: [
      { type: 1, value: 1, start: 0, end: 3 },
      { type: 2, value: 0xffffff, start: 2, end: 3 },
      { type: 3, value: 0, start: 2, end: 3 },
    ],
  });
  const overlay = document.querySelector<HTMLElement>("[data-ibus-preedit]")!;
  expect(overlay).not.toBeNull();
  expect(overlay.textContent).toContain("😀한");
  const syllable = [...overlay.querySelectorAll("span")].find((x) => x.textContent === "한")!;
  expect(syllable.style.color).toBe("rgb(255, 255, 255)");
  expect(syllable.style.backgroundColor).toBe("rgb(0, 0, 0)");
  expect(syllable.style.textDecorationLine).toBe("underline");
  expect(element.value).toBe("ab😀cd");
  expect(input).not.toHaveBeenCalled();
  expect(onPreedit).toHaveBeenCalledOnce();
  adapter.setPreedit(undefined);
  expect(document.querySelector("[data-ibus-preedit]")).toBeNull();
});
for (const tag of ["input", "textarea"] as const) {
  test(`${tag}: focused commit is a trusted native edit and undo restores selection replacement`, async () => {
    const { element, adapter, reset } = field(tag, "abc");
    await userEvent.click(element);
    element.setSelectionRange(1, 2);
    element.dispatchEvent(new Event("select"));
    reset.mockClear();
    const events: InputEvent[] = [];
    element.addEventListener("input", (e) => events.push(e as InputEvent));
    adapter.commit("한");
    expect(element.value).toBe("a한c");
    expect(events.map((e) => [e.inputType, e.data, e.isTrusted])).toEqual([["insertText", "한", true]]);
    expect(reset).not.toHaveBeenCalled();
    expect(document.execCommand("undo")).toBe(true);
    expect(element.value).toBe("abc");
  });
  test(`${tag}: deletion plus commit batch is one native undo step`, async () => {
    const { element, adapter } = field(tag, "a😀bc");
    await userEvent.click(element);
    element.setSelectionRange(3, 3);
    const events: InputEvent[] = [];
    element.addEventListener("input", (e) => events.push(e as InputEvent));
    adapter.batch(() => {
      adapter.deleteSurrounding(-2, 2);
      adapter.commit("한");
    });
    expect(element.value).toBe("a한bc");
    expect(events).toHaveLength(1);
    expect(events[0]!.inputType).toBe("insertText");
    expect(document.execCommand("undo")).toBe(true);
    expect(element.value).toBe("a😀bc");
  });
}
function onMac() {
  const platforms = { platform: "MacIntel", userAgentData: { platform: "macOS" } };
  for (const [name, value] of Object.entries(platforms)) {
    Object.defineProperty(navigator, name, { configurable: true, get: () => value });
    cleanup.push(() => Reflect.deleteProperty(navigator, name));
  }
}
const chord = (key: string, modifiers: KeyboardEventInit = { ctrlKey: true }) =>
  new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, ...modifiers });
for (const tag of ["input", "textarea"] as const)
  test(`${tag}: declined undo, redo and select-all chords perform their native edits`, async () => {
    const { element, adapter } = field(tag, "a");
    await userEvent.click(element);
    adapter.commit("한");

    expect(adapter.replayKey(chord("z"))).toBe(true);
    expect(element.value).toBe("a");
    expect(adapter.replayKey(chord("Z", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(element.value).toBe("a한");
    adapter.replayKey(chord("z"));
    expect(adapter.replayKey(chord("y"))).toBe(true);
    expect(element.value).toBe("a한");

    expect(adapter.replayKey(chord("a"))).toBe(true);
    expect([element.selectionStart, element.selectionEnd]).toEqual([0, 2]);
  });
test("declined cut and copy chords use the native clipboard commands while the page has user activation", async () => {
  const { element, adapter } = field("textarea", "abc");
  await userEvent.click(element);
  const commands = vi.spyOn(document, "execCommand");
  element.setSelectionRange(1, 2);

  expect(adapter.replayKey(chord("c"))).toBe(true);
  expect(commands).toHaveBeenLastCalledWith("copy");
  expect(adapter.replayKey(chord("x"))).toBe(true);
  expect(commands).toHaveBeenLastCalledWith("cut");
  expect(element.value).toBe("ac");
});
test("a declined undo replayed inside a batch undoes the batch's earlier commit", async () => {
  const { element, adapter } = field("textarea", "a");
  await userEvent.click(element);
  adapter.commit("b");

  adapter.batch(() => {
    adapter.commit("한");
    adapter.replayKey(chord("z"));
  });
  expect(element.value).toBe("ab");
});
test("a declined cut replayed inside a batch leaves the caret where the cut text was", async () => {
  const { element, adapter } = field("textarea", "abc");
  await userEvent.click(element);
  element.setSelectionRange(1, 2);

  adapter.batch(() => adapter.replayKey(chord("x")));
  expect(element.value).toBe("ac");
  expect([element.selectionStart, element.selectionEnd]).toEqual([1, 1]);
});
test("a replayed undo reports its reset after the command, where the reset can edit natively", async () => {
  const { element, adapter, reset } = field("textarea", "a");
  await userEvent.click(element);
  adapter.commit("b");
  reset.mockClear();
  const inputs: InputEvent[] = [];
  element.addEventListener("input", (event) => inputs.push(event as InputEvent));
  reset.mockImplementation(() => adapter.commit("!"));

  expect(adapter.replayKey(chord("z"))).toBe(true);
  expect(reset).toHaveBeenCalledOnce();
  expect(element.value).toBe("a!");
  expect(inputs.map((event) => [event.inputType, event.isTrusted])).toEqual([
    ["historyUndo", true],
    ["insertText", true],
  ]);
});
test("paste, unbound chords and Mac Control chords report that their action was lost", async () => {
  const { element, adapter } = field("textarea", "abc");
  await userEvent.click(element);

  expect(adapter.replayKey(chord("v"))).toBe(false);
  expect(adapter.replayKey(chord("b"))).toBe(false);
  expect(adapter.replayKey(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }))).toBe(true);
  expect(adapter.replayKey(new KeyboardEvent("keyup", { key: "v", ctrlKey: true }))).toBe(true);
  expect(element.value).toBe("abc");

  adapter.commit("d");
  onMac();
  const mac = textareaAdapter(element);
  expect(mac.replayKey(chord("z"))).toBe(false);
  expect(element.value).toBe("abcd");
});
test("Mac maps undo, redo and select all to Command", async () => {
  onMac();
  const { element, adapter } = field("textarea", "a");
  await userEvent.click(element);
  adapter.commit("한");

  expect(adapter.replayKey(chord("z", { metaKey: true }))).toBe(true);
  expect(element.value).toBe("a");
  expect(adapter.replayKey(chord("Z", { metaKey: true, shiftKey: true }))).toBe(true);
  expect(element.value).toBe("a한");
  expect(adapter.replayKey(chord("y", { metaKey: true }))).toBe(false);
  expect(adapter.replayKey(chord("a", { metaKey: true }))).toBe(true);
  expect([element.selectionStart, element.selectionEnd]).toEqual([0, 2]);
});
test("unfocused and unavailable native command paths use setRangeText and synthetic input", () => {
  const { element, adapter, reset } = field();
  element.blur();
  const range = vi.spyOn(element, "setRangeText");
  const events: InputEvent[] = [];
  element.addEventListener("input", (e) => events.push(e as InputEvent));
  adapter.commit("X");
  expect(range).toHaveBeenCalledOnce();
  expect(events[0]!.isTrusted).toBe(false);
  expect(reset).not.toHaveBeenCalled();
  element.focus();
  vi.spyOn(document, "execCommand").mockReturnValue(false);
  adapter.commit("Y");
  expect(range).toHaveBeenCalledTimes(2);
  expect(element.value).toBe("ab😀cdXY");
});
test("finishes a native edit that reports success short of the edit", () => {
  const { element, adapter } = field("textarea", "a\n");
  element.setSelectionRange(0, 2);
  // What WebKit's delete does with a selection ending at a textarea's final
  // line break: it keeps the break.
  const native = document.execCommand.bind(document);
  vi.spyOn(document, "execCommand").mockImplementation((command, ...rest) => {
    if (command !== "delete") return native(command, ...rest);
    element.setRangeText("", element.selectionStart!, element.selectionEnd! - 1, "end");
    return true;
  });
  const events: InputEvent[] = [];
  element.addEventListener("input", (event) => events.push(event as InputEvent));

  adapter.replayKey(new KeyboardEvent("keydown", { key: "Delete" }));
  expect(element.value).toBe("");
  expect(element.selectionStart).toBe(0);
  expect(events.map(({ inputType }) => inputType)).toEqual(["deleteContentBackward"]);
});
test("replays code points, deletion, textarea Enter and selection arrows", () => {
  const { element, adapter } = field("textarea", "a😀b");
  element.setSelectionRange(3, 3);
  const replay = (key: string, shiftKey = false) => adapter.replayKey(new KeyboardEvent("keydown", { key, shiftKey }));
  replay("Backspace");
  expect(element.value).toBe("ab");
  replay("😀");
  replay("Delete");
  expect(element.value).toBe("a😀");
  replay("ArrowLeft");
  expect(element.selectionStart).toBe(1);
  replay("ArrowRight", true);
  expect(element.selectionEnd).toBe(3);
  replay("Enter");
  expect(element.value).toBe("a\n");
  replay("ArrowUp");
  expect(element.selectionStart).toBe(0);
  replay("ArrowDown");
  expect(element.selectionStart).toBe(2);
  const single = field("input", "abc");
  single.adapter.replayKey(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(single.element.value).toBe("abc");
});
test("resets external value changes and pointer moves, suppresses own edits, and tears down", () => {
  const { element, adapter, reset } = field();
  adapter.commit("X");
  expect(reset).not.toHaveBeenCalled();
  element.value = "external";
  expect(reset).toHaveBeenCalledOnce();
  element.dispatchEvent(new PointerEvent("pointerdown"));
  expect(reset).toHaveBeenCalledTimes(2);
  adapter.setPreedit({ text: "X", cursor: 1, attributes: [] });
  cleanup.pop()!();
  expect(document.querySelector("[data-ibus-preedit]")).toBeNull();
  reset.mockClear();
  element.value = "after";
  element.dispatchEvent(new PointerEvent("pointerdown"));
  expect(reset).not.toHaveBeenCalled();
});
for (const mode of ["input", "multiline", "scroll", "rtl"] as const)
  test(`caret and overlay geometry: ${mode}`, () => {
    const { element, adapter } = field(
      mode === "input" ? "input" : "textarea",
      mode === "rtl" ? "אבג" : mode === "input" ? "abc" : "abc\ndef\nghi\njkl\nmno",
    );
    if (mode === "rtl") element.dir = "rtl";
    if (mode === "scroll") element.scrollTop = 30;
    const before = adapter.caretRect()!;
    expect(before).toBeDefined();
    const box = element.getBoundingClientRect();
    if (mode === "input") expect(Math.abs(before.y + before.height / 2 - (box.y + box.height / 2))).toBeLessThan(3);
    if (mode === "multiline" || mode === "scroll")
      expect(Math.abs(before.y - (box.y + 10 + 4 * 24 - element.scrollTop))).toBeLessThan(4);
    if (mode === "rtl") expect(before.x).toBeGreaterThan(box.x + 100);
    adapter.setPreedit({ text: "X", cursor: 0, attributes: [] });
    const atStart = adapter.caretRect()!;
    expect(Math.abs(atStart.x - before.x)).toBeLessThan(3);
    expect(Math.abs(atStart.y - before.y)).toBeLessThan(3);
    adapter.setPreedit({ text: "X", cursor: 1, attributes: [] });
    expect(Math.abs(adapter.caretRect()!.x - atStart.x)).toBeGreaterThan(5);
  });
test("reports the overlay caret through SetCursorLocation", () =>
  run(async ({ router, connections, field }) => {
    const f = field("abc");
    f.element.focus();
    await select(router);
    connections.a[0]!.outcome = { _tag: "reply", ret: 1, records: [preedit("한")] };
    key(f.element);
    await select(router);
    const rect = f.adapter.caretRect()!;
    expect(
      connections.a[0]!.sent.some(
        ({ request }) =>
          request._tag === "SetCursorLocation" && request.x === Math.round(rect.x) && request.y === Math.round(rect.y),
      ),
    ).toBe(true);
  }));

test("separate committed replies can be undone independently", async () => {
  const { element, adapter } = field("textarea", "abc");
  await userEvent.click(element);
  element.setSelectionRange(3, 3);
  adapter.batch(() => adapter.commit("X"));
  adapter.batch(() => adapter.commit("Y"));
  document.execCommand("undo");
  expect(element.value).toBe("abcX");
  document.execCommand("undo");
  expect(element.value).toBe("abc");
});
test("batch navigation and successive surrounding deletions see pending state", () => {
  const { element, adapter } = field("textarea", "a😀bc");
  adapter.batch(() => adapter.replayKey(new KeyboardEvent("keydown", { key: "ArrowLeft" })));
  expect(element.selectionStart).toBe(4);
  adapter.batch(() => {
    adapter.deleteSurrounding(-1, 1);
    expect(adapter.surrounding(100)).toEqual({ text: "a😀c", cursor: 3, anchor: 3 });
    adapter.deleteSurrounding(-2, 2);
    adapter.commit("X");
  });
  expect(element.value).toBe("aXc");
});
test("wrapped lines and horizontal scrolling follow independent monospace geometry", () => {
  const { element, adapter } = field("textarea", "x".repeat(40));
  element.scrollTop = 0;
  const canvas = document.createElement("canvas").getContext("2d")!;
  canvas.font = "20px monospace";
  const columns = Math.floor((element.clientWidth - 16) / canvas.measureText("x").width);
  const lines = Math.ceil(element.value.length / columns) - 1;
  const rect = adapter.caretRect()!;
  expect(
    Math.abs(rect.y - (40 + 10 + lines * 24)),
    JSON.stringify({
      rect: rect.toJSON(),
      columns,
      lines,
      clientWidth: element.clientWidth,
      scroll: element.scrollTop,
      advance: canvas.measureText("x").width,
    }),
  ).toBeLessThan(4);
  const single = field("input", "x".repeat(60));
  single.element.setSelectionRange(30, 30);
  single.element.scrollLeft = 0;
  const before = single.adapter.caretRect()!;
  single.element.scrollLeft = 100;
  const after = single.adapter.caretRect()!;
  expect(Math.abs(before.x - after.x - single.element.scrollLeft)).toBeLessThan(2);
});
test("scroll repositions the existing overlay and teardown releases observers and listeners", () => {
  const { element, adapter } = field("textarea", "a\nb\nc\nd\ne");
  const disconnect = vi.spyOn(ResizeObserver.prototype, "disconnect");
  element.scrollTop = 0;
  adapter.setPreedit({ text: "X", cursor: 1, attributes: [] });
  const span = () =>
    [...document.querySelectorAll<HTMLSpanElement>("[data-ibus-preedit] span")].find((s) => s.textContent === "X")!;
  const before = span().getBoundingClientRect();
  element.scrollTop = 24;
  element.dispatchEvent(new Event("scroll"));
  expect(Math.abs(before.y - span().getBoundingClientRect().y - 24)).toBeLessThan(2);
  cleanup.pop()!();
  expect(disconnect).toHaveBeenCalledOnce();
  element.dispatchEvent(new Event("scroll"));
  window.dispatchEvent(new Event("resize"));
  expect(document.querySelector("[data-ibus-preedit]")).toBeNull();
});
test("preedit changes do not add undo history entries", async () => {
  const { element, adapter } = field("textarea", "abc");
  await userEvent.click(element);
  element.setSelectionRange(3, 3);
  adapter.commit("X");
  adapter.setPreedit({ text: "한", cursor: 1, attributes: [] });
  adapter.setPreedit(undefined);
  document.execCommand("undo");
  expect(element.value).toBe("abc");
});

test("trusted pointer movement commits at the old insertion point before moving selection", () =>
  run(async ({ router, connections, field }) => {
    const f = field("abcd");
    f.element.style.cssText = "font:20px monospace;width:300px;height:100px";
    f.element.focus();
    f.element.setSelectionRange(1, 1);
    await select(router);
    connections.a[0]!.outcome = { _tag: "reply", ret: 1, records: [preedit("X", 1)] };
    key(f.element);
    await userEvent.click(f.element, { position: { x: 200, y: 10 } });
    expect(f.element.value).toBe("aXbcd");
    expect(f.element.selectionStart).toBeGreaterThan(2);
  }));
test("committing the selected text still emits one native insertText event", async () => {
  const { element, adapter } = field("textarea", "abc");
  await userEvent.click(element);
  element.setSelectionRange(1, 2);
  const events: InputEvent[] = [];
  element.addEventListener("input", (e) => events.push(e as InputEvent));
  adapter.batch(() => adapter.commit("b"));
  expect(element.value).toBe("abc");
  expect(events.map((e) => [e.inputType, e.data, e.isTrusted])).toEqual([["insertText", "b", true]]);
});
