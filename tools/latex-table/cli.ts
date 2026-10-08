// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// cli.ts UNICODE.XML ALIASES.TSV: writes latex.table to standard output.

import { readFileSync } from "node:fs";
import { generate } from "./latex-table.ts";

const [xmlPath, aliasesPath] = process.argv.slice(2);
if (xmlPath === undefined || aliasesPath === undefined) {
  console.error("usage: cli.ts UNICODE.XML ALIASES.TSV");
  process.exit(2);
}

try {
  process.stdout.write(generate(readFileSync(xmlPath, "utf8"), readFileSync(aliasesPath, "utf8"), aliasesPath));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
