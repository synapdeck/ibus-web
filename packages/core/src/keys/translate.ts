// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { IBusModifier as M } from "@ibus-web/protocol";
import { evdevForCode } from "./dom-codes.generated.ts";
import { keysymForCodepoint } from "./keysyms.generated.ts";
import { namedKeysym } from "./named.ts";
import { usKeysym } from "./us.ts";
export interface KeyLike {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly isComposing: boolean;
  readonly repeat: boolean;
  getModifierState(key: string): boolean;
}
export function translateKey(
  event: KeyLike,
  layout: "us" | "default",
): { keyval: number; keycode: number; state: number } | undefined {
  if (event.isComposing || event.key === "Dead") return undefined;
  const mod = (name: string) => event.getModifierState(name);
  const shift = mod("Shift"),
    lock = mod("CapsLock"),
    numLock = mod("NumLock"),
    altGraph = mod("AltGraph");
  const state =
    (shift ? M.SHIFT : 0) |
    (lock ? M.LOCK : 0) |
    (numLock ? M.MOD2 : 0) |
    (mod("Meta") ? M.MOD4 | M.SUPER | M.META : 0) |
    (altGraph ? M.MOD5 : (mod("Control") ? M.CONTROL : 0) | (mod("Alt") ? M.MOD1 : 0)) |
    (event.type === "keyup" ? M.RELEASE : 0);
  const keycode = evdevForCode(event.code) ?? 0;
  let keyval: number | undefined;
  if (event.code === "Lang1" || event.code === "Lang2" || event.key === "HangulMode" || event.key === "HanjaMode")
    keyval = namedKeysym(event.key, event.code);
  // The US layout has no third level, so an AltGr key types what the system layout gives it.
  else if (layout === "us" && !altGraph)
    keyval = usKeysym(keycode, event.code, shift, lock, numLock) ?? namedKeysym(event.key, event.code);
  else {
    const points = [...event.key];
    if (points.length === 1) {
      const cp = event.key.codePointAt(0)!;
      keyval = cp <= 0xff ? cp : (keysymForCodepoint(cp) ?? 0x01000000 + cp);
    } else keyval = namedKeysym(event.key, event.code);
  }
  return keyval === undefined || keyval === 0 ? undefined : { keyval, keycode, state };
}
