// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { keysymByName } from "./keysyms.generated.ts";
const names: Readonly<Record<string, string>> = {
  Backspace: "BackSpace",
  Tab: "Tab",
  Enter: "Return",
  Escape: "Escape",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "Prior",
  PageDown: "Next",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Shift: "Shift_L",
  Control: "Control_L",
  Alt: "Alt_L",
  Meta: "Super_L",
  AltGraph: "ISO_Level3_Shift",
  CapsLock: "Caps_Lock",
  NumLock: "Num_Lock",
  ScrollLock: "Scroll_Lock",
  Pause: "Pause",
  PrintScreen: "Print",
  ContextMenu: "Menu",
  HangulMode: "Hangul",
  HanjaMode: "Hangul_Hanja",
};
export function namedKeysym(key: string, code: string): number | undefined {
  if (code === "Lang1" || key === "HangulMode") return 0xff31;
  if (code === "Lang2" || key === "HanjaMode") return 0xff34;
  if (/^F([1-9]|1[0-2])$/.test(key)) return keysymByName.get(key);
  const name = names[key];
  return name === undefined ? undefined : keysymByName.get(name.replace(/_L$/, code.endsWith("Right") ? "_R" : "_L"));
}
