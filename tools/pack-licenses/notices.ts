// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

/**
 * Notices a bundled repository file brings with it, beyond its license texts:
 * the copyright lines its permissive licenses require to travel with the code.
 */
export const NOTICES: Readonly<Record<string, readonly string[]>> = {
  "packages/core/src/keys/keysyms.generated.ts": ["NOTICES/keysymdef.txt"],
  "packages/core/src/keys/dom-codes.generated.ts": ["NOTICES/chromium.txt"],
  "packages/protocol/src/keyval-unicode.generated.ts": ["NOTICES/keysymdef.txt"],
};
