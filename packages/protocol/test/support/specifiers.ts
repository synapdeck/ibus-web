// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Any module specifier at all: static and dynamic imports, re-exports, import types and require.
export const specifiers = (source: string): string[] =>
  [
    ...source.matchAll(/\bimport\s*(?:type\b[^'"]*?)?(?:[\w*{}\s,]+from\s*)?["']([^"']+)["']/g),
    ...source.matchAll(/\bexport\s*(?:type\s*)?(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g),
    ...source.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']/g),
  ].map((match) => match[1]!);
