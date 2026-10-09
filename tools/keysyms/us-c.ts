// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { parseDomCodes } from "./dom-codes.ts";

// The flags let the C lookup apply the page's rules without DOM codes.
export function generateUSHeader(exportJson: string, domCodeSource: string): string {
  const rows = JSON.parse(exportJson) as [number, [number, number][]][];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("empty XKB export");
  const keypad = new Set(
    [...parseDomCodes(domCodeSource)].filter(([code]) => code.startsWith("Numpad")).map(([, evdev]) => evdev),
  );
  const entries = rows
    .filter(([, levels]) => levels.length > 0)
    .sort(([a], [b]) => a - b)
    .map(([code, levels]) => {
      const [lower, upper] = levels;
      const flags = [
        lower![1] >= 97 && lower![1] <= 122 ? "US_KEY_LETTER" : undefined,
        keypad.has(code) ? "US_KEY_KEYPAD" : undefined,
      ].filter((flag) => flag !== undefined);
      return `{${code}, ${flags.length ? flags.join(" | ") : "0"}, 0x${lower![0].toString(16)}, 0x${(upper?.[0] ?? 0).toString(16)}},`;
    });
  return `/* SPDX-FileCopyrightText: The xkeyboard-config contributors
 * SPDX-License-Identifier: LicenseRef-xkeyboard-config */
/* Generated from xkeyboard-config US (evdev/pc105/us, empty variant and
 * options), resolved by libxkbcommon, by \`nix run .#write-files\`. Source
 * notices: LICENSES/LicenseRef-xkeyboard-config.txt. */
#pragma once
#include <glib.h>

enum { US_KEY_LETTER = 1, US_KEY_KEYPAD = 2 };

typedef struct {
  guint16 code;
  guint8 flags;
  guint32 lower;
  guint32 upper;
} UsKey;

/* Sorted by evdev code; an upper of 0 means the key has one level. */
static const UsKey us_keys[] = {
${entries.join("\n")}
};
`;
}

if (import.meta.main) {
  const [exportPath, domPath] = process.argv.slice(2);
  if (!exportPath || !domPath) throw new Error("Usage: us-c.ts resolved-keymap.json dom_code_data.inc");
  process.stdout.write(generateUSHeader(readFileSync(exportPath, "utf8"), readFileSync(domPath, "utf8")));
}
