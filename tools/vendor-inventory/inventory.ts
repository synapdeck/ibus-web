// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";

type Root = ReturnType<typeof fromMarkdown>;
type Node = Root["children"][number];

/** How a vendored file relates to upstream, from its inventory row. */
export type Origin = "ours" | "unchanged" | "adapted" | "generated";

export interface Row {
  path: string;
  origin: Origin;
  description: string;
}

export interface Inventory {
  version: string;
  hash: string;
  rows: Row[];
}

/** The directories of the vendored tree, relative to the library's root. */
export const vendoredDirectories = ["src/ibus", "include/ibus-1.0"];

function text(node: Node | Root): string {
  if ("value" in node) return node.value;
  if ("children" in node) return node.children.map((child) => text(child as Node)).join("");
  return "";
}

function* walk(node: Node | Root): Generator<Node> {
  if (node.type !== "root") yield node;
  if ("children" in node) for (const child of node.children) yield* walk(child as Node);
}

function classify(path: string, description: string): Origin {
  if (description.startsWith("Ours")) return "ours";
  if (description.startsWith("Generated")) return "generated";
  if (description.startsWith("Upstream")) return description.endsWith("; unchanged.") ? "unchanged" : "adapted";
  throw new Error(`${path}: origin must start with Ours, Upstream or Generated: ${description}`);
}

/**
 * Reads the inventory README: the IBus release it names, the unpacked
 * source's hash, and its table's rows, each a code-formatted path and a
 * description starting with the file's origin.
 */
export function parseInventory(markdown: string): Inventory {
  const tree = fromMarkdown(markdown, { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] });
  let version: string | undefined;
  let hash: string | undefined;
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const node of walk(tree)) {
    if (node.type === "paragraph" && version === undefined) {
      version = /^Imported from IBus (\d+\.\d+\.\d+),/.exec(text(node))?.[1];
    } else if (node.type === "inlineCode" && hash === undefined && node.value.startsWith("sha256-")) {
      hash = node.value;
    } else if (node.type === "table") {
      for (const row of node.children.slice(1)) {
        const [file, description] = row.children;
        const code = file?.children.length === 1 ? file.children[0] : undefined;
        if (code?.type !== "inlineCode" || description === undefined) {
          throw new Error(`malformed inventory row: ${text(row)}`);
        }
        if (seen.has(code.value)) throw new Error(`duplicate inventory entry: ${code.value}`);
        seen.add(code.value);
        const summary = text(description).trim();
        rows.push({ path: code.value, origin: classify(code.value, summary), description: summary });
      }
    }
  }
  if (version === undefined) throw new Error('inventory names no release ("Imported from IBus X.Y.Z,")');
  if (hash === undefined) throw new Error("inventory names no sha256- source hash");
  return { version, hash, rows };
}

/** Where a vendored file's counterpart lives in IBus's source tree. */
export function upstreamPath(path: string): string {
  const name = basename(path);
  return name.endsWith(".gschema.xml") ? join("data/dconf", name) : join("src", name);
}

/** A version header as IBus's configure would generate it from its template. */
export function expandVersionTemplate(template: string, version: string): string {
  const [major, minor, micro] = version.split(".");
  const parts: Record<string, string | undefined> = { MAJOR: major, MINOR: minor, MICRO: micro };
  const expanded = template.replace(/@IBUS_(MAJOR|MINOR|MICRO)_VERSION@/g, (_, part: string) => parts[part] ?? "");
  const left = /@[A-Z_]+@/.exec(expanded);
  if (left !== null) throw new Error(`template substitution ${left[0]} has no value`);
  return expanded;
}

async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export interface CheckOptions {
  /** The library's root, holding the vendored tree. */
  root: string;
  readme: string;
  /** The unpacked IBus release. */
  upstream: string;
  /** The release and source hash the build's IBus source has. */
  version: string;
  hash: string;
}

/**
 * Checks the vendored tree against its inventory and the IBus release it
 * names, returning every discrepancy: files listed or not, a release or hash
 * other than the build's, unchanged files that differ from upstream, adapted
 * files that don't, and generated files that aren't what the template gives.
 */
export async function checkInventory(options: CheckOptions): Promise<string[]> {
  const { root, upstream, version, hash } = options;
  const inventory = parseInventory(await readFile(options.readme, "utf8"));
  const errors: string[] = [];
  if (inventory.version !== version) {
    errors.push(`inventory imports IBus ${inventory.version}, but the IBus source is ${version}`);
  }
  if (inventory.hash !== hash) {
    errors.push(`inventory's source hash is ${inventory.hash}, but the IBus source's is ${hash}`);
  }

  const actual = new Set<string>();
  for (const directory of vendoredDirectories) {
    const entries = await readdir(join(root, directory), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) actual.add(relative(root, join(entry.parentPath, entry.name)));
    }
  }
  const listed = new Set(inventory.rows.map((row) => row.path));
  for (const path of [...actual].filter((path) => !listed.has(path)).sort())
    errors.push(`not in the inventory: ${path}`);
  for (const path of [...listed].filter((path) => !actual.has(path)).sort()) errors.push(`no such file: ${path}`);

  for (const row of inventory.rows) {
    if (row.origin === "ours" || !actual.has(row.path)) continue;
    const local = await readFile(join(root, row.path));
    if (row.origin === "generated") {
      if (!row.description.includes(`release ${inventory.version}`)) {
        errors.push(`${row.path}: generated, but not said to be from release ${inventory.version}`);
      }
      const template = await readOptional(join(upstream, `${upstreamPath(row.path)}.in`));
      if (template === undefined) {
        errors.push(`${row.path}: no template ${upstreamPath(row.path)}.in upstream`);
      } else if (expandVersionTemplate(template.toString("utf8"), version) !== local.toString("utf8")) {
        errors.push(`${row.path}: differs from ${upstreamPath(row.path)}.in generated for ${version}`);
      }
      continue;
    }
    const original = await readOptional(join(upstream, upstreamPath(row.path)));
    if (original === undefined) {
      errors.push(`${row.path}: upstream has no ${upstreamPath(row.path)}`);
    } else if (row.origin === "unchanged" && !original.equals(local)) {
      errors.push(`${row.path}: marked unchanged, but differs from upstream ${upstreamPath(row.path)}`);
    } else if (row.origin === "adapted" && original.equals(local)) {
      errors.push(`${row.path}: identical to upstream, so should be marked unchanged`);
    }
  }
  return errors;
}
