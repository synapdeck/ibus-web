// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { usLevels } from "./us.generated.ts";
export function usKeysym(
  keycode: number,
  code: string,
  shift: boolean,
  lock: boolean,
  numLock: boolean,
): number | undefined {
  const levels = usLevels(keycode);
  if (!levels) return undefined;
  const lower = levels[0];
  if (!lower) return undefined;
  const letter = lower[1] >= 97 && lower[1] <= 122;
  // IBus selects keypad levels by NumLock alone and inverts letter case under Lock.
  const upper = code.startsWith("Numpad") ? numLock : letter ? shift !== lock : shift;
  return (upper ? (levels[1] ?? lower) : lower)[0];
}
