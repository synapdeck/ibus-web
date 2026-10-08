// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

const OPERATORS = new Set(["AND", "OR", "WITH"]);

/** The license and exception identifiers an SPDX expression names, sorted, each once. */
export function licenseIds(expression: string): string[] {
  const tokens = expression.replace(/[()]/g, " ").split(/\s+/);
  const ids = tokens.filter((token) => token !== "" && !OPERATORS.has(token.toUpperCase()));

  return [...new Set(ids)].sort();
}
