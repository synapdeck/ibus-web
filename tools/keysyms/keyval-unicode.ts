// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { readFileSync } from "node:fs";
import { parseKeysyms } from "./keysymdef.ts";

// Where IBus's table departs from keysymdef.h's annotations: the angle
// brackets, which keysymdef.h gives the deprecated U+2329 and U+232A; the
// legacy euro and currency keysyms, which it leaves unannotated; and the
// keypad's Tab and Enter, which IBus maps to nothing.
const ibusDepartures: ReadonlyMap<number, number | undefined> = new Map([
  [0x0abc, 0x27e8],
  [0x0abe, 0x27e9],
  [0x13a4, 0x20ac],
  ...Array.from({ length: 12 }, (_, index) => [0x20a0 + index, 0x20a0 + index] as [number, number]),
  [0xff89, undefined],
  [0xff8d, undefined],
]);

// The legacy keysyms beyond Latin-1 and the character each stands for, in
// keysym order, as ibus_keyval_to_unicode() maps them.
export function legacyKeyvals(source: string): [number, number][] {
  const table = new Map<number, number>();
  for (const [keysym, codepoint] of parseKeysyms(source).byKeysym)
    if (keysym > 0xff && keysym < 0x01000000) table.set(keysym, codepoint);

  for (const [keysym, codepoint] of ibusDepartures) {
    if (codepoint === undefined) table.delete(keysym);
    else table.set(keysym, codepoint);
  }
  return [...table].toSorted(([a], [b]) => a - b);
}

export function generateKeyvalUnicode(source: string): string {
  const notice = source.slice(0, source.indexOf("*/") + 2);
  return `${notice}
// Generated from X11 keysymdef.h, with IBus's departures from it.

const legacy: ReadonlyMap<number, number> = new Map(${JSON.stringify(legacyKeyvals(source))});

/**
 * The character a keyval stands for, as \`ibus_keyval_to_unicode()\` gives it: Latin-1's printable keysyms, which are
 * their code points, a Unicode keysym's code point, and the legacy keysyms' characters, among them control characters
 * such as BackSpace's U+0008. Undefined for a keyval that stands for none, or for a Unicode keysym past U+10FFFF or of
 * a surrogate, which is no character.
 */
export function keyvalToUnicode(keyval: number): number | undefined {
  if ((keyval >= 0x20 && keyval <= 0x7e) || (keyval >= 0xa0 && keyval <= 0xff)) return keyval;

  if (keyval >= 0x01000001 && keyval <= 0x0110ffff) {
    const codepoint = keyval - 0x01000000;
    return codepoint >= 0xd800 && codepoint <= 0xdfff ? undefined : codepoint;
  }
  return legacy.get(keyval);
}
`;
}

if (import.meta.main) {
  const file = process.argv[2];
  if (file === undefined) throw new Error("Usage: keyval-unicode.ts keysymdef.h");
  process.stdout.write(generateKeyvalUnicode(readFileSync(file, "utf8")));
}
