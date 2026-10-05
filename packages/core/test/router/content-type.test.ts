// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, expect, it } from "vitest";
import { textareaAdapter } from "../../src/adapters/textarea.ts";
afterEach(() => document.body.replaceChildren());
const input = (attrs: Record<string, string> = {}) => {
  const element = document.createElement("input");
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  document.body.append(element);
  return element;
};
it.each([
  [{ type: "password" }, 8, true],
  [{ autocomplete: "section-login current-password" }, 8, true],
  [{ autocomplete: "new-password" }, 8, true],
  [{ type: "email" }, 6, false],
  [{ type: "url" }, 5, false],
  [{ inputmode: "numeric" }, 2, false],
  [{ inputmode: "decimal" }, 3, false],
  [{ autocomplete: "given-name" }, 7, false],
])("maps content attributes %o to purpose and privacy", (attrs, purpose, disabled) => {
  expect(textareaAdapter(input(attrs)).contentType()).toMatchObject({ purpose, disabled });
});
it("reports multiline, spellcheck and capitalization hints", () => {
  const element = document.createElement("textarea");
  element.spellcheck = false;
  element.setAttribute("autocapitalize", "words");
  expect(textareaAdapter(element).contentType().hints).toBe(16384 | 2 | 32);
});
it("commits and deletes with input events, without resetting its own edits", () => {
  const element = input();
  element.value = "a😀b";
  element.setSelectionRange(3, 3);
  const adapter = textareaAdapter(element);
  const resets: string[] = [],
    inputs: string[] = [];
  const cleanup = adapter.onReset(() => resets.push(element.value));
  element.addEventListener("input", () => inputs.push(element.value));
  adapter.batch(() => {
    adapter.deleteSurrounding(-2, 2);
    adapter.commit("X");
  });
  expect(element.value).toBe("aXb");
  expect(inputs).toEqual(["ab", "aXb"]);
  expect(resets).toEqual([]);
  element.value = "external";
  element.dispatchEvent(new Event("input"));
  expect(resets).toEqual(["external"]);
  cleanup();
});
it("detects programmatic value changes on key entry and moving selections, and removes listeners", () => {
  const element = input();
  element.value = "abcd";
  element.setSelectionRange(2, 2);
  const adapter = textareaAdapter(element);
  let resets = 0;
  const cleanup = adapter.onReset(() => resets++);
  element.focus();
  element.dispatchEvent(new Event("selectionchange"));
  expect(resets).toBe(0);
  element.setSelectionRange(1, 1);
  document.dispatchEvent(new Event("selectionchange"));
  expect(resets).toBe(1);
  element.value = "changed";
  element.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
  expect(resets).toBe(2);
  cleanup();
  element.value = "after";
  element.dispatchEvent(new Event("input"));
  expect(resets).toBe(2);
});
it("replays editing keys by code point, inserts Unicode forwards and ignores releases", () => {
  const element = input();
  element.value = "a😀b";
  element.setSelectionRange(3, 3);
  const adapter = textareaAdapter(element);
  adapter.replayKey(new KeyboardEvent("keydown", { key: "Backspace" }));
  expect(element.value).toBe("ab");
  adapter.forwardKey({ keyval: 0x0101f600, keycode: 0, state: 0 });
  expect(element.value).toBe("a😀b");
  adapter.forwardKey({ keyval: 0x61, keycode: 0, state: 1 << 30 });
  expect(element.value).toBe("a😀b");
  adapter.replayKey(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
  expect(element.selectionStart).toBe(1);
  adapter.replayKey(new KeyboardEvent("keydown", { key: "Delete" }));
  expect(element.value).toBe("ab");
});
it("reports preedit separately and replays Enter only in a textarea", () => {
  const element = document.createElement("textarea");
  document.body.append(element);
  const seen: unknown[] = [];
  const adapter = textareaAdapter(element, { onPreedit: (p) => seen.push(p) });
  adapter.setPreedit({ text: "composition", cursor: 2, attributes: [] });
  expect(element.value).toBe("");
  adapter.replayKey(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(element.value).toBe("\n");
  adapter.setPreedit(undefined);
  expect(seen).toHaveLength(2);
});
it("edits selectionless email input at the value end and emits input", () => {
  const element = input({ type: "email" });
  element.value = "a@example.test";
  let inputs = 0;
  element.addEventListener("input", () => inputs++);
  const adapter = textareaAdapter(element);
  adapter.commit("x");
  adapter.deleteSurrounding(-1, 1);
  expect(element.value).toBe("a@example.test");
  expect(inputs).toBe(2);
});
it("surrounding returns a bounded UTF-16 window without splitting astral characters", () => {
  const element = input();
  element.value = "x😀a😀y";
  element.setSelectionRange(3, 4, "backward");
  expect(textareaAdapter(element).surrounding(2)).toEqual({ text: "x😀a😀", cursor: 3, anchor: 4 });
});
it.each([
  ["email", 6],
  ["url", 5],
  ["tel-national", 4],
])("maps autocomplete %s on text fields", (autocomplete, purpose) => {
  expect(textareaAdapter(input({ autocomplete })).contentType().purpose).toBe(purpose);
});
