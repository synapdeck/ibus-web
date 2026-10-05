// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { readFileSync } from "node:fs";
export function parseDomCodes(source: string): Map<string, number> {
  const result = new Map<string, number>();
  // Commented rows describe unused USB keys and must not enter the table.
  const uncommented = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  for (const match of uncommented.matchAll(
    /\bDOM_CODE\(\s*0x[\da-f]+\s*,\s*(0x[\da-f]+)\s*,\s*0x[\da-f]+\s*,\s*0x[\da-f]+\s*,\s*0x[\da-f]+\s*,\s*"([^"]+)"\s*,/gi,
  )) {
    const evdev = Number(match[1]);
    if (evdev !== 0) result.set(match[2]!, evdev);
  }
  return result;
}
export function generateDomCodes(source: string): string {
  const notice = source.split("\n").slice(0, 3).join("\n");
  return (
    notice +
    "\n// Generated from Chromium dom_code_data.inc.\n" +
    `const codes: ReadonlyMap<string, number> = new Map(${JSON.stringify([...parseDomCodes(source)])});
export function evdevForCode(code: string): number | undefined { return codes.get(code); }
`
  );
}
if (import.meta.main) {
  const file = process.argv[2];
  if (file === undefined) throw new Error("Usage: dom-codes.ts dom_code_data.inc");
  process.stdout.write(generateDomCodes(readFileSync(file, "utf8")));
}
