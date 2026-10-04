// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import process from "node:process";
import type { Cast } from "./cast-audit.ts";

/** The report's casts of `name`, which must number exactly one. */
export function selectOne(casts: Cast[], name: string): Cast[] {
  const selected = casts.filter((cast) => cast.function === name);
  if (selected.length !== 1) throw new Error(`expected one cast of ${name}, found ${selected.length}`);
  return selected;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error("usage: select.ts <report.json> <function>");
  const casts = JSON.parse(readFileSync(args[0]!, "utf8")) as Cast[];
  process.stdout.write(`${JSON.stringify(selectOne(casts, args[1]!), null, 2)}\n`);
}
