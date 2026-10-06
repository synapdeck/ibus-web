// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { Preedit } from "../router/replay.ts";
import { measureCaret, mirror, scrollMirror, textCaret } from "./mirror.ts";
import type { NativeInput } from "./undo.ts";
const color = (value: number) => `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
export function preeditOverlay(element: NativeInput, cursor: () => number) {
  let preedit: Preedit | undefined;
  let copy: HTMLDivElement | undefined;
  let clip: HTMLDivElement | undefined;
  let composition: HTMLSpanElement | undefined;
  let observer: ResizeObserver | undefined;
  const window = element.ownerDocument.defaultView!;
  const render = () => {
    clip?.remove();
    clip = undefined;
    copy = undefined;
    composition = undefined;
    if (!preedit || !element.isConnected) return;
    copy = mirror(element);
    const box = element.getBoundingClientRect();
    clip = element.ownerDocument.createElement("div");
    clip.style.all = "initial";
    clip.dataset.ibusPreedit = "";
    clip.setAttribute("aria-hidden", "true");
    Object.assign(clip.style, {
      position: "fixed",
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      overflow: "hidden",
      pointerEvents: "none",
      zIndex: "2147483646",
    });
    element.ownerDocument.body.append(clip);
    clip.append(copy);
    Object.assign(copy.style, { position: "absolute", left: "0px", top: "0px" });
    const style = window.getComputedStyle(element);
    copy.append(element.value.slice(0, cursor()));
    composition = element.ownerDocument.createElement("span");
    copy.append(composition);
    const boundaries = new Set([0, preedit.text.length]);
    for (const attr of preedit.attributes) {
      boundaries.add(Math.max(0, Math.min(preedit.text.length, attr.start)));
      boundaries.add(Math.max(0, Math.min(preedit.text.length, attr.end)));
    }
    const points = [...boundaries].sort((a, b) => a - b);
    for (let i = 1; i < points.length; i++) {
      const start = points[i - 1]!,
        end = points[i]!;
      const span = element.ownerDocument.createElement("span");
      span.textContent = preedit.text.slice(start, end);
      span.style.color = style.color;
      span.style.backgroundColor = style.backgroundColor;
      for (const attr of preedit.attributes) {
        if (attr.start > start || attr.end < end) continue;
        if (attr.type === 1) {
          span.style.textDecorationLine = attr.value ? "underline" : "none";
          span.style.textDecorationStyle = attr.value === 2 ? "double" : attr.value === 4 ? "wavy" : "solid";
          if (attr.value === 4) span.style.textDecorationColor = "red";
        } else if (attr.type === 2) span.style.color = color(attr.value);
        else if (attr.type === 3) span.style.backgroundColor = color(attr.value);
      }
      composition.append(span);
    }
    if (!preedit.text) composition.append("\u200b");
    copy.append(element.value.slice(cursor()), "\u200b");
    scrollMirror(copy, element);
    // Bidi runs can shift when composition starts. Anchor decoration at the real caret.
    const anchor = measureCaret(element, cursor());
    const start = textCaret(composition, 0);
    copy.style.left = `${anchor.x - start.x}px`;
    copy.style.top = `${anchor.y - start.y}px`;
  };
  const scroll = (event: Event) => {
    const target = event.target;
    if (
      target === element ||
      target === window ||
      target === element.ownerDocument ||
      (target instanceof Element && target.contains(element))
    )
      render();
  };
  const clear = () => {
    clip?.remove();
    clip = undefined;
    copy = undefined;
    composition = undefined;
    observer?.disconnect();
    observer = undefined;
    window.removeEventListener("scroll", scroll, true);
    window.removeEventListener("resize", render);
  };
  return {
    set(value: Preedit | undefined) {
      clear();
      preedit = value;
      if (value) {
        window.addEventListener("scroll", scroll, true);
        window.addEventListener("resize", render);
        observer = new ResizeObserver(render);
        observer.observe(element);
        render();
      }
    },
    caretRect() {
      if (preedit) {
        render();
        if (composition) return textCaret(composition, Math.max(0, Math.min(preedit.text.length, preedit.cursor)));
      }
      return measureCaret(element, cursor());
    },
    dispose() {
      preedit = undefined;
      clear();
    },
  };
}
