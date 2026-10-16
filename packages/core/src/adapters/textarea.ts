// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { IBusInputHints as Hints, IBusInputPurpose as Purpose, IBusModifier } from "@ibus-web/protocol";
import { codepointForKeysym } from "../keys/keysyms.generated.ts";
import { surroundingWindow, toUtf16 } from "../router/surrounding.ts";
import type { Preedit, SurfaceAdapter } from "../router/replay.ts";
import { nativeEdits } from "./undo.ts";
import { preeditOverlay } from "./overlay.ts";

type Input = HTMLTextAreaElement | HTMLInputElement;
const isTextarea = (element: Input) => element.localName === "textarea";
const position = (element: Input) =>
  element.selectionDirection === "backward"
    ? { cursor: element.selectionStart ?? element.value.length, anchor: element.selectionEnd ?? element.value.length }
    : { cursor: element.selectionEnd ?? element.value.length, anchor: element.selectionStart ?? element.value.length };
const modifierKeys = new Set(["Alt", "AltGraph", "CapsLock", "Control", "Fn", "Hyper", "Meta", "OS", "Shift", "Super"]);
const applePlatform = () =>
  /Mac|iPhone|iPad|iPod/i.test(
    (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform || navigator.platform,
  );
const boundary = (text: string, offset: number, step: number) => {
  if (step < 0) return offset - (Array.from(text.slice(0, offset)).at(-1)?.length ?? 0);
  return offset + (text.codePointAt(offset)! > 0xffff ? 2 : offset < text.length ? 1 : 0);
};
const words = new Intl.Segmenter(undefined, { granularity: "word" });
// The start of the word at or before offset, past any spaces and punctuation between them, as browsers move.
const wordStart = (text: string, offset: number) => {
  let start = 0;
  for (const segment of words.segment(text.slice(0, offset))) if (segment.isWordLike) start = segment.index;
  return start;
};
// The end of the word at or after offset. Windows stops at the next word's start instead; macOS and Linux don't.
const wordEnd = (text: string, offset: number) => {
  for (const segment of words.segment(text)) {
    const end = segment.index + segment.segment.length;
    if (segment.isWordLike && end > offset) return end;
  }
  return text.length;
};

export function textareaAdapter(
  element: Input,
  options: { onPreedit?: (preedit: Preedit | undefined) => void } = {},
): SurfaceAdapter {
  const edits = nativeEdits(element);
  const editingPosition = () => {
    const state = edits.current();
    return state.direction === "backward"
      ? { cursor: state.start, anchor: state.end }
      : { cursor: state.end, anchor: state.start };
  };
  const overlay = preeditOverlay(element, () => position(element).cursor);
  const apple = applePlatform();
  let ownEdit = 0;
  const resetChecks = new Set<() => void>();
  let lastValue = element.value;
  let lastSelection = position(element);
  const remember = () => {
    lastValue = element.value;
    lastSelection = position(element);
  };
  const replace = (text: string, start: number, end: number, selection: SelectionMode = "end") => {
    ownEdit++;
    try {
      edits.replace(text, start, end, selection === "preserve");
      remember();
    } finally {
      ownEdit--;
    }
  };
  const move = (next: number, extend: boolean) => {
    if (element.selectionStart === null) return;
    const { anchor } = editingPosition();
    edits.select(
      extend ? Math.min(anchor, next) : next,
      extend ? Math.max(anchor, next) : next,
      extend && next < anchor ? "backward" : "forward",
    );
    remember();
  };
  const replay = (key: string, shift = false, modified = false) => {
    if (modified || element.disabled || element.readOnly) return;
    const { start, end, value } = edits.current();
    const { cursor } = editingPosition();
    if (key === "Backspace") replace("", start === end ? boundary(value, start, -1) : start, end);
    else if (key === "Delete") replace("", start, start === end ? boundary(value, end, 1) : end);
    else if (key === "Enter") {
      if (isTextarea(element)) replace("\n", start, end);
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key)) {
      let next = cursor;
      if (key === "ArrowLeft") next = !shift && start !== end ? start : boundary(value, cursor, -1);
      if (key === "ArrowRight") next = !shift && start !== end ? end : boundary(value, cursor, 1);
      const lineStart = value.lastIndexOf("\n", cursor - 1) + 1;
      const lineEndIndex = value.indexOf("\n", cursor);
      const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex;
      if (key === "Home") next = lineStart;
      if (key === "End") next = lineEnd;
      if (key === "ArrowUp") {
        const previousStart = value.lastIndexOf("\n", lineStart - 2) + 1;
        next = lineStart === 0 ? 0 : Math.min(lineStart - 1, previousStart + cursor - lineStart);
      }
      if (key === "ArrowDown") {
        const nextEnd = value.indexOf("\n", lineEnd + 1);
        next =
          lineEnd === value.length
            ? lineEnd
            : Math.min(nextEnd < 0 ? value.length : nextEnd, lineEnd + 1 + cursor - lineStart);
      }
      move(next, shift);
    } else if ([...key].length === 1) replace(key, start, end);
  };
  // Word-wise deletion and movement, and line and document movement, by the platform's chords: Option and Command on
  // Apple platforms, Ctrl elsewhere. Returns false for a chord that isn't one of them.
  const navigate = (event: KeyboardEvent): boolean => {
    const alt = event.altKey && !event.getModifierState("AltGraph");
    const word = apple ? alt && !event.ctrlKey && !event.metaKey : event.ctrlKey && !alt && !event.metaKey;
    const line = apple && event.metaKey && !event.ctrlKey && !alt;
    if (!word && !line) return false;

    const { start, end, value } = edits.current();
    const { cursor } = editingPosition();
    const lineStart = value.lastIndexOf("\n", cursor - 1) + 1;
    const lineEndIndex = value.indexOf("\n", cursor);
    const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex;
    const editable = !element.disabled && !element.readOnly;

    switch (event.key) {
      case "Backspace":
        if (event.shiftKey) return false;
        if (editable)
          if (start !== end) replace("", start, end);
          else replace("", word ? wordStart(value, cursor) : lineStart, cursor);
        return true;
      case "Delete":
        if (event.shiftKey || !word) return false;
        if (editable) replace("", start, start !== end ? end : wordEnd(value, cursor));
        return true;
      case "ArrowLeft":
        move(word ? wordStart(value, cursor) : lineStart, event.shiftKey);
        return true;
      case "ArrowRight":
        move(word ? wordEnd(value, cursor) : lineEnd, event.shiftKey);
        return true;
      case "ArrowUp":
      case "ArrowDown":
        if (!line) return false;
        move(event.key === "ArrowUp" ? 0 : value.length, event.shiftKey);
        return true;
      case "Home":
      case "End":
        if (apple) return false;
        move(event.key === "Home" ? 0 : value.length, event.shiftKey);
        return true;
      default:
        return false;
    }
  };
  // Paste has no page-side equivalent: execCommand("paste") is refused in web content.
  const shortcut = (event: KeyboardEvent): boolean => {
    const primary = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!primary || event.altKey) return false;
    const letter = /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : /^Key([A-Z])$/.exec(event.code)?.[1];
    if (letter?.toLowerCase() === "a" && !event.shiftKey) {
      edits.select(0, edits.current().value.length, "forward");
      remember();
      return true;
    }

    const commands: Record<string, string | undefined> = event.shiftKey
      ? { z: "redo" }
      : { z: "undo", y: apple ? undefined : "redo", x: "cut", c: "copy" };
    const command = commands[letter?.toLowerCase() ?? ""];
    const document = element.ownerDocument;
    if (!command || document.activeElement !== element) return false;

    // A reset raised from inside the command's own input event could not edit natively, so the change is
    // reported once the command has returned.
    ownEdit++;
    let done: boolean;
    try {
      done = edits.native(() => {
        try {
          return document.execCommand(command);
        } catch {
          return false;
        }
      });
    } finally {
      ownEdit--;
    }
    for (const check of resetChecks) check();
    return done;
  };
  return {
    element,
    capabilities: () => ({ preedit: true, auxText: true, lookupTable: true, surroundingText: true }),
    contentType: () => {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
      const password =
        type === "password" || autocomplete.some((value) => value === "current-password" || value === "new-password");
      const purposes: Record<string, number> = {
        email: Purpose.EMAIL,
        url: Purpose.URL,
        tel: Purpose.PHONE,
        number: Purpose.NUMBER,
        numeric: Purpose.DIGITS,
        decimal: Purpose.NUMBER,
        date: Purpose.DATE,
        time: Purpose.TIME,
        "datetime-local": Purpose.DATETIME,
      };
      let purpose = password ? Purpose.PASSWORD : (purposes[element.inputMode] ?? purposes[type] ?? Purpose.FREE_FORM);
      if (!password)
        for (const value of autocomplete) {
          if (["name", "given-name", "family-name", "additional-name", "nickname"].includes(value))
            purpose = Purpose.NAME;
          else if (value === "email") purpose = Purpose.EMAIL;
          else if (value === "url") purpose = Purpose.URL;
          else if (value === "tel" || value.startsWith("tel-")) purpose = Purpose.PHONE;
        }
      let hints = isTextarea(element) ? Hints.MULTILINE : 0;
      if (element.hasAttribute("spellcheck")) hints |= element.spellcheck ? Hints.SPELLCHECK : Hints.NO_SPELLCHECK;
      const caps: Record<string, number> = {
        characters: Hints.UPPERCASE_CHARS,
        words: Hints.UPPERCASE_WORDS,
        sentences: Hints.UPPERCASE_SENTENCES,
      };
      hints |= caps[element.getAttribute("autocapitalize") ?? ""] ?? 0;
      if (element.inputMode === "none") hints |= Hints.INHIBIT_OSK;
      if (password) hints |= Hints.PRIVATE | Hints.HIDDEN_TEXT;
      return { purpose, hints, disabled: password || element.disabled || element.readOnly };
    },
    surrounding: (window) => {
      const value = surroundingWindow({ text: edits.current().value, ...editingPosition() }, window);
      return { ...value, cursor: toUtf16(value.text, value.cursor), anchor: toUtf16(value.text, value.anchor) };
    },
    caretRect: () => overlay.caretRect(),
    batch: (apply) => {
      ownEdit++;
      try {
        edits.batch(apply);
      } finally {
        ownEdit--;
        remember();
      }
    },
    commit: (text) => replace(text, edits.current().start, edits.current().end),
    deleteSurrounding: (offset, count) => {
      const start = Math.max(0, Math.min(edits.current().value.length, editingPosition().cursor + offset));
      replace("", start, Math.min(edits.current().value.length, start + count), "preserve");
    },
    setPreedit: (preedit) => {
      overlay.set(preedit);
      options.onPreedit?.(preedit);
    },
    replayKey: (event) => {
      if (event.type === "keyup" || modifierKeys.has(event.key)) return true;
      if (event.metaKey || (!event.getModifierState("AltGraph") && (event.ctrlKey || event.altKey)))
        return navigate(event) || shortcut(event);
      replay(event.key, event.shiftKey);
      return true;
    },
    forwardKey: (key) => {
      if (key.state & IBusModifier.RELEASE) return;
      const named: Record<number, string> = {
        0xff08: "Backspace",
        0xffff: "Delete",
        0xff0d: "Enter",
        0xff51: "ArrowLeft",
        0xff52: "ArrowUp",
        0xff53: "ArrowRight",
        0xff54: "ArrowDown",
        0xff50: "Home",
        0xff57: "End",
      };
      const cp =
        key.keyval >= 0x01000000
          ? key.keyval - 0x01000000
          : key.keyval <= 0xff
            ? key.keyval
            : codepointForKeysym(key.keyval);
      const value = named[key.keyval] ?? (cp !== undefined && cp <= 0x10ffff ? String.fromCodePoint(cp) : undefined);
      if (value)
        replay(
          value,
          !!(key.state & IBusModifier.SHIFT),
          !!(key.state & (IBusModifier.CONTROL | IBusModifier.MOD1 | IBusModifier.SUPER | IBusModifier.META)),
        );
    },
    onReset: (listener) => {
      remember();
      const check = () => {
        if (ownEdit) return;
        const current = position(element);
        if (
          lastValue !== element.value ||
          current.cursor !== lastSelection.cursor ||
          current.anchor !== lastSelection.anchor
        ) {
          remember();
          listener();
        }
      };
      // Observe assignment without polling; preserve a host framework's own accessor.
      const ownValue = Object.getOwnPropertyDescriptor(element, "value");
      const nativeValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
      const descriptor = ownValue ?? nativeValue;
      let setter: ((value: string) => void) | undefined;
      if (descriptor?.get && descriptor.set && descriptor.configurable !== false) {
        const get = descriptor.get,
          set = descriptor.set;
        setter = (value) => {
          set.call(element, value);
          check();
        };
        Object.defineProperty(element, "value", {
          configurable: true,
          enumerable: descriptor.enumerable ?? true,
          get: () => get.call(element),
          set: setter,
        });
      }
      const selection = () => {
        if (element.ownerDocument.activeElement === element) check();
      };
      const events = ["input", "keydown", "focus", "pointerup", "select", "selectionchange"];
      const pointer = () => {
        if (!ownEdit) {
          remember();
          listener();
        }
      };
      resetChecks.add(check);
      element.addEventListener("pointerdown", pointer, true);
      for (const event of events) element.addEventListener(event, check, true);
      element.ownerDocument.addEventListener("selectionchange", selection);
      return () => {
        overlay.dispose();
        resetChecks.delete(check);
        if (setter && Object.getOwnPropertyDescriptor(element, "value")?.set === setter) {
          if (ownValue) Object.defineProperty(element, "value", ownValue);
          else Reflect.deleteProperty(element, "value");
        }
        element.removeEventListener("pointerdown", pointer, true);
        for (const event of events) element.removeEventListener(event, check, true);
        element.ownerDocument.removeEventListener("selectionchange", selection);
      };
    },
  };
}
