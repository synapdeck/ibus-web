// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { readFileSync } from "node:fs";
export function parseKeysyms(source: string) {
  const byName = new Map<string, number>();
  const canonicalName = new Map<number, string>();
  const byCodepoint = new Map<number, number>();
  const byKeysym = new Map<number, number>();
  for (const line of source.split("\n")) {
    const define = /^#define\s+XK_(\w+)\s+(0x[0-9a-fA-F]+)\b(.*)$/.exec(line);
    if (!define) continue;
    const name = define[1]!;
    const keysym = Number(define[2]);
    byName.set(name, keysym);
    if (!canonicalName.has(keysym)) canonicalName.set(keysym, name);
    const annotation = /(?:\/\*|\/\/)\s*([<(]?)U\+([0-9A-Fa-f]{4,6})\b/.exec(define[3]!);
    if (!annotation) continue;
    const cp = Number.parseInt(annotation[2]!, 16);
    if (!byKeysym.has(keysym)) byKeysym.set(keysym, cp);
    if (annotation[1] === "" && !byCodepoint.has(cp)) byCodepoint.set(cp, keysym);
  }
  return { byName, canonicalName, byCodepoint, byKeysym };
}
export function generateKeysyms(source: string): string {
  const maps = parseKeysyms(source);
  const notice = source.slice(0, source.indexOf("*/") + 2);
  const map = (name: string, entries: Map<string, number> | Map<number, number>) =>
    `const ${name}: ReadonlyMap<${name === "keysymByName" ? "string" : "number"}, number> = new Map(${JSON.stringify([...entries])});\n`;
  return (
    notice +
    "\n// Generated from X11 keysymdef.h.\n" +
    map("keysymByName", maps.byName) +
    "export { keysymByName };\n" +
    map("byCodepoint", maps.byCodepoint) +
    map("byKeysym", maps.byKeysym) +
    `
function validCodepoint(cp: number): boolean {
 return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff);
}
export function keysymForCodepoint(cp: number): number | undefined {
 if (!validCodepoint(cp)) return undefined;
 return byCodepoint.get(cp) ?? (cp >= 0x100 ? 0x01000000 + cp : undefined);
}
export function codepointForKeysym(keysym: number): number | undefined {
 const legacy = byKeysym.get(keysym);
 if (legacy !== undefined) return legacy;
 const cp = keysym - 0x01000000;
 return keysym >= 0x01000100 && validCodepoint(cp) ? cp : undefined;
}
`
  );
}
if (import.meta.main) {
  const file = process.argv[2];
  if (file === undefined) throw new Error("Usage: keysymdef.ts keysymdef.h");
  process.stdout.write(generateKeysyms(readFileSync(file, "utf8")));
}
