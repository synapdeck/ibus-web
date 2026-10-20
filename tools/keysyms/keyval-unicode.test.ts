// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import { legacyKeyvals } from "./keyval-unicode.ts";

test("the legacy table holds the annotated keysyms beyond Latin-1, with IBus's departures", () => {
  expect(
    legacyKeyvals(`
#define XK_eacute 0x00e9 /* U+00E9 LATIN SMALL LETTER E WITH ACUTE */
#define XK_Cyrillic_a 0x06c1 /* U+0430 CYRILLIC SMALL LETTER A */
#define XK_leftanglebracket 0x0abc /*(U+2329 LEFT-POINTING ANGLE BRACKET)*/
#define XK_KP_Enter 0xff8d /*<U+000D CARRIAGE RETURN>*/
#define XK_BackSpace 0xff08 /* U+0008 BACKSPACE */
#define XK_Wcircumflex 0x1000174 /* U+0174 LATIN CAPITAL LETTER W WITH CIRCUMFLEX */
`),
  ).toEqual([
    [0x06c1, 0x0430],
    [0x0abc, 0x27e8],
    [0x0abe, 0x27e9],
    [0x13a4, 0x20ac],
    ...Array.from({ length: 12 }, (_, index) => [0x20a0 + index, 0x20a0 + index]),
    [0xff08, 0x0008],
  ]);
});
