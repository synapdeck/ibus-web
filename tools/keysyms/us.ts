// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
export function generateUS(source: string): string {
  const rows = JSON.parse(source) as [number, [number, number][]][];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("empty XKB export");
  return `// SPDX-FileCopyrightText: The xkeyboard-config contributors
// SPDX-License-Identifier: LicenseRef-xkeyboard-config
// Generated from xkeyboard-config US (evdev/pc105/us, empty variant and options), resolved by libxkbcommon.
// Source notices: LICENSES/xkeyboard-config-COPYING.txt.
const levels: ReadonlyMap<number, readonly (readonly [number, number])[]> = new Map(${JSON.stringify(rows)});
export function usLevels(evdev: number): readonly (readonly [number, number])[] | undefined { return levels.get(evdev); }
`;
}
if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: us.ts resolved-keymap.json");
  process.stdout.write(generateUS(readFileSync(path, "utf8")));
}
