// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { parseDomCodes } from "./dom-codes.ts";
import { usKeysym } from "../../packages/core/src/keys/us.ts";

const SHIFT = 1,
  LOCK = 2,
  MOD2 = 16,
  MOD5 = 128;

// Each line is "evdev state keyval": the page's answer, which the runtime's lookup must give too.
export function usVectors(domCodeSource: string): string {
  const lines = new Set<string>();
  for (const [code, evdev] of parseDomCodes(domCodeSource))
    for (let state = 0; state < 8; state++) {
      const shift = (state & 1) !== 0,
        lock = (state & 2) !== 0,
        numLock = (state & 4) !== 0;
      const keyval = usKeysym(evdev, code, shift, lock, numLock);
      if (keyval === undefined) continue;
      const mask = (shift ? SHIFT : 0) | (lock ? LOCK : 0) | (numLock ? MOD2 : 0);
      lines.add(`${evdev} ${mask} ${keyval}`);
      lines.add(`${evdev} ${mask | MOD5} ${keyval}`);
    }
  return [...lines].join("\n") + "\n";
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: us-vectors.ts dom_code_data.inc");
  process.stdout.write(usVectors(readFileSync(path, "utf8")));
}
