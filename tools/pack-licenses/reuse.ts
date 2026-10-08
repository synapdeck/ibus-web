// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A file's license as `reuse lint` sees it: from its own header or `.license`
// sidecar, and from the last REUSE.toml annotation whose path matches it.
// `reuse` itself can't be asked about one file, and over a Nix build's tree
// without git it would scan every node_modules.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";

import { parse } from "smol-toml";

// Spelled in pieces so REUSE doesn't read this file's code as its tags.
const KEY = ["SPDX", "License", "Identifier"].join("-");
const TAG = `${KEY}:`;

export interface Annotation {
  readonly patterns: readonly RegExp[];
  readonly license: string | undefined;
  readonly precedence: "closest" | "aggregate" | "override";
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A REUSE.toml path pattern: `*` stops at a slash, `**` doesn't, `\` escapes. */
export function globToRegExp(glob: string): RegExp {
  let pattern = "";

  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);

    if (char === "\\" && i + 1 < glob.length) {
      pattern += escape(glob.charAt(++i));
    } else if (char === "*" && glob.charAt(i + 1) === "*") {
      pattern += ".*";
      i++;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else {
      pattern += escape(char);
    }
  }

  return new RegExp(`^${pattern}$`);
}

/** The licenses a file's text declares, joined with AND, or undefined if it declares none. */
export function headerLicense(text: string): string | undefined {
  const found: string[] = [];

  for (const line of text.split("\n")) {
    const at = line.indexOf(TAG);
    if (at === -1) continue;

    const value = line
      .slice(at + TAG.length)
      .replace(/\s*(?:\*\/|-->)\s*$/, "")
      .trim();
    if (value !== "") found.push(value);
  }

  if (found.length <= 1) return found[0];

  return found.map((expression) => `(${expression})`).join(" AND ");
}

export function parseReuseToml(text: string): Annotation[] {
  const document = parse(text) as { annotations?: readonly Record<string, unknown>[] };

  return (document.annotations ?? []).map((table) => {
    const path = table["path"];
    const paths = typeof path === "string" ? [path] : (path as readonly string[]);
    const license = table[KEY];

    return {
      patterns: paths.map(globToRegExp),
      license: Array.isArray(license) ? license.join(" AND ") : (license as string | undefined),
      precedence: (table["precedence"] ?? "closest") as Annotation["precedence"],
    };
  });
}

async function ownLicense(file: string): Promise<string | undefined> {
  const sidecar = `${file}.license`;
  const bytes = await readFile(existsSync(sidecar) ? sidecar : file);

  // A binary file can't carry a header.
  if (bytes.includes(0)) return undefined;

  return headerLicense(bytes.toString("utf8"));
}

/** The SPDX expression REUSE gives a file under root, or undefined if it gives none. */
export async function licenseOf(
  root: string,
  file: string,
  annotations: readonly Annotation[],
): Promise<string | undefined> {
  const path = relative(root, file).split(sep).join("/");
  const annotation = annotations.findLast((candidate) => candidate.patterns.some((pattern) => pattern.test(path)));

  if (annotation?.precedence === "override") return annotation.license;

  const declared = await ownLicense(file);
  if (annotation?.license === undefined) return declared;
  if (declared === undefined) return annotation.license;

  return annotation.precedence === "aggregate" ? `(${declared}) AND (${annotation.license})` : declared;
}
