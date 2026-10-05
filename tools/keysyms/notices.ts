// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";

export function keysymNotice(source: string): string {
  const notice = /^\/\*+\n([\s\S]*?)^\*+\//m.exec(source);
  if (!notice) throw new Error("Expected keysymdef.h's leading copyright comment");
  return notice[1]!;
}

export function chromiumNotice(source: string): string {
  return source.replace(/^\/\/ ?/gm, "");
}

if (import.meta.main) {
  const [kind, path] = process.argv.slice(2);
  if (!path || (kind !== "keysymdef" && kind !== "chromium")) {
    throw new Error("Usage: notices.ts keysymdef|chromium source");
  }
  const source = readFileSync(path, "utf8");
  process.stdout.write(kind === "keysymdef" ? keysymNotice(source) : chromiumNotice(source));
}
