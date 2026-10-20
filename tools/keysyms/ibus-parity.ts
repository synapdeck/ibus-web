// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Holds the generated keyvalToUnicode() to libibus's ibus_keyval_to_unicode(),
// given that function's result for each keyval as "<keyval> <code point>" in
// hex.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [table, dump] = process.argv.slice(2);
if (table === undefined || dump === undefined) throw new Error("Usage: ibus-parity.ts table.ts keyvals.txt");

const { keyvalToUnicode } = (await import(pathToFileURL(table).href)) as {
  keyvalToUnicode: (keyval: number) => number | undefined;
};

// IBus answers 0 for a keyval that stands for nothing, and a Unicode
// keysym's value even where that is no character.
const character = (codepoint: number): number | undefined =>
  codepoint === 0 || (codepoint >= 0xd800 && codepoint <= 0xdfff) || codepoint > 0x10ffff ? undefined : codepoint;

const lines = readFileSync(dump, "utf8").trim().split("\n");
const differing: string[] = [];
for (const line of lines) {
  const [keyval, codepoint] = line.split(" ").map((field) => Number.parseInt(field, 16)) as [number, number];
  const generated = keyvalToUnicode(keyval);
  if (generated !== character(codepoint))
    differing.push(`0x${keyval.toString(16)}: IBus 0x${codepoint.toString(16)}, table ${String(generated)}`);
}

if (differing.length > 0) {
  console.error(`${differing.length} keyvals differ from ibus_keyval_to_unicode():\n${differing.join("\n")}`);
  process.exit(1);
}
console.log(`${lines.length} keyvals agree with ibus_keyval_to_unicode()`);
