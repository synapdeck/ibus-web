// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { NativeInput } from "./undo.ts";
const properties = [
  "direction",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "fontStretch",
  "letterSpacing",
  "wordSpacing",
  "textAlign",
  "textIndent",
  "textTransform",
  "tabSize",
  "lineHeight",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
] as const;

/** A clipped copy of the control's text layout, in viewport coordinates. */
export function mirror(element: NativeInput): HTMLDivElement {
  const document = element.ownerDocument;
  const style = document.defaultView!.getComputedStyle(element);
  const box = element.getBoundingClientRect();
  const copy = document.createElement("div");
  copy.style.all = "initial";
  for (const property of properties) copy.style[property] = style[property];
  Object.assign(copy.style, {
    position: "fixed",
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    boxSizing: "border-box",
    borderStyle: "solid",
    borderColor: "transparent",
    margin: "0",
    overflow: "hidden",
    pointerEvents: "none",
    whiteSpace: element.localName === "input" || element.getAttribute("wrap") === "off" ? "pre" : "pre-wrap",
    overflowWrap: "break-word",
    color: "transparent",
    zIndex: "2147483646",
  });
  // Textarea scrollbars reduce its line box even though the mirror is clipped.
  copy.style.paddingRight = `${parseFloat(style.paddingRight) + element.offsetWidth - element.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)}px`;
  if (element.localName === "input")
    copy.style.lineHeight = `${element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)}px`;
  copy.setAttribute("aria-hidden", "true");
  document.body.append(copy);
  return copy;
}
export function scrollMirror(copy: HTMLElement, element: NativeInput): void {
  copy.scrollTop = element.scrollTop;
  copy.scrollLeft = element.scrollLeft;
}
export function textCaret(root: HTMLElement, offset: number): DOMRect {
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent!.length;
    if (offset <= length || !walker.nextNode()) {
      const range = document.createRange();
      range.setStart(node, Math.min(offset, length));
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      return new DOMRect(rect.x, rect.y, 0, rect.height);
    }
    offset -= length;
    walker.currentNode = node;
    node = walker.nextNode();
  }
  return root.getBoundingClientRect();
}
export function measureCaret(element: NativeInput, cursor: number): DOMRect {
  const copy = mirror(element);
  try {
    copy.textContent = element.value + "\u200b";
    scrollMirror(copy, element);
    return textCaret(copy, cursor);
  } finally {
    copy.remove();
  }
}
