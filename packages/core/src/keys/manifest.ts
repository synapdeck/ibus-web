// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { keysymByName } from "./keysyms.generated.ts";
export function validateKeyboard<
  T extends { readonly layout: "us" | "default"; readonly passThrough: readonly string[] },
>(keyboard: T): T {
  for (const name of keyboard.passThrough)
    if (keysymByName.get(name) === undefined) throw new Error(`Unknown pass-through keysym: ${name}`);
  return keyboard;
}
