// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { keyvalToUnicode } from "@ibus-web/protocol";

// A control character, as BackSpace, Return, Escape and Delete give, stands
// for no text an engine would show.
const isControl = (codepoint: number): boolean => codepoint < 0x20 || (codepoint >= 0x7f && codepoint < 0xa0);

// The text a keyval stands for, as a module script's processKey receives it:
// the character ibus_keyval_to_unicode() gives, but for a control character.
export const keyCharacter = (keyval: number): string => {
  const codepoint = keyvalToUnicode(keyval);
  return codepoint === undefined || isControl(codepoint) ? "" : String.fromCodePoint(codepoint);
};
