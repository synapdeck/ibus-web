// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { extname, relative } from "node:path";
import process from "node:process";
import { castOperandName } from "./c-operand.ts";
import { castTypes, readSarif, sourcePath } from "./sarif.ts";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv/dist/2020.js";
import { parse, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";

export interface Cast {
  file: string;
  function: string | null;
  from: string;
  to: string;
  line?: number;
  reason?: string;
}
export function report(stderr: string, root: string): Cast[] {
  const log = readSarif(stderr);
  const casts: Cast[] = [];
  for (const run of log.runs) {
    for (const result of run.results ?? []) {
      const types = castTypes(run, result);
      if (types === null) continue;
      const location = result.locations?.[0]?.physicalLocation;
      if (!location?.artifactLocation || !location.region) {
        throw new Error("cast diagnostic has no source location");
      }
      const path = sourcePath(run, location.artifactLocation, root);
      const language = [".cc", ".cpp", ".cxx", ".C", ".hpp"].includes(extname(path)) ? "cpp" : "c";
      const source = readFileSync(path, "utf8");
      casts.push({
        file: relative(root, path),
        function: castOperandName(source, location.region, language),
        ...types,
        line: location.region.startLine,
      });
    }
  }
  return casts;
}

export interface Allowance extends Cast {
  reason: string;
}

const validateAllowList = new Ajv2020({ allErrors: true, allowUnionTypes: true }).compile<{ casts: Allowance[] }>(
  JSON.parse(readFileSync(new URL("cast-audit.schema.json", import.meta.url), "utf8")),
);

function describeError(document: unknown, error: ErrorObject): string {
  const detail =
    error.keyword === "additionalProperties" ? `${error.message}: ${error.params.additionalProperty}` : error.message;
  // Name the offending entry by its index and content so the message can be
  // matched to the allow-list without line numbers.
  const entry = /^\/casts\/\d+/.exec(error.instancePath)?.[0];
  if (entry === undefined) return `${error.instancePath || "document"}: ${detail}`;
  const value = (document as { casts: unknown[] }).casts[Number(entry.slice("/casts/".length))];
  return `${error.instancePath} ${JSON.stringify(value)}: ${detail}`;
}

export function parseAllowList(text: string): Allowance[] {
  const errors: ParseError[] = [];
  const document: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    const found = errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`);
    throw new Error(`invalid cast allow-list: ${found.join(", ")}`);
  }
  if (!validateAllowList(document)) {
    const found = validateAllowList.errors!.map((error) => describeError(document, error));
    throw new Error(`invalid cast allow-list:\n  ${found.join("\n  ")}`);
  }
  return document.casts;
}

const key = (cast: Cast): string => JSON.stringify([cast.file, cast.function, cast.from, cast.to]);
export function compare(actual: Cast[], allowed: Cast[]): { missing: Cast[]; unexpected: Cast[] } {
  const missing = [...allowed];
  const unexpected: Cast[] = [];
  for (const cast of actual) {
    const index = missing.findIndex((entry) => key(entry) === key(cast));
    if (index === -1) unexpected.push(cast);
    else missing.splice(index, 1);
  }
  return { missing, unexpected };
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "report" && args.length) {
    const casts = args.flatMap((path) => report(readFileSync(path, "utf8"), process.cwd()));
    process.stdout.write(`${JSON.stringify(casts, null, 2)}\n`);
    for (const cast of casts)
      console.error(`${cast.file}:${cast.line}: ${cast.function ?? "<expression>"}: ${cast.from} → ${cast.to}`);
  } else if (command === "compare" && args.length === 2) {
    const allowed = parseAllowList(readFileSync(args[1], "utf8"));
    const result = compare(JSON.parse(readFileSync(args[0], "utf8")), allowed);
    for (const [kind, casts] of Object.entries(result)) {
      for (const cast of casts) console.error(`${kind}: ${JSON.stringify(cast)}`);
    }
    if (result.missing.length || result.unexpected.length) process.exitCode = 1;
  } else {
    throw new Error("usage: cast-audit.ts report <sarif...> | compare <report.json> <allow.jsonc>");
  }
}
