// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { generate, parseAliases, readCharacters } from "./latex-table.ts";

const fixture = fileURLToPath(new URL("fixtures/unicode.xml", import.meta.url));
const xml = readFileSync(fixture, "utf8");

const aliases = ["# Ours.", "\\to\tU+2192", "", "\\emptyset\tU+2205", "\\neq\tU+2260", ""].join("\n");

const expected = [
  "# LaTeX commands to Unicode, generated from W3C xml-entities' unicode.xml,",
  "# which is under the W3C Software Notice and License.",
  "name = LaTeX",
  "languages = und-Zmth",
  "mode = command",
  "trigger = \\",
  "---",
  "",
  "# Classic LaTeX names",
  "\\ast\t*",
  "\\textbackslash\t\\\\",
  "\\textdegree\t°",
  "\\alpha\tα",
  "\\rightarrow\t→",
  "\\varnothing\t∅",
  "\\NotEqualTilde\t\u2242\u0338",
  "",
  "# unicode-math names",
  "\\mathampersand\t&",
  "\\backslash\t\\\\",
  "\\mupalpha\tα",
  "\\ast\t∗",
  "\\ne\t≠",
  "\\mbfA\t𝐀",
  "",
  "# Common spellings unicode.xml doesn't name",
  "\\to\t→",
  "\\emptyset\t∅",
  "\\neq\t≠",
  "",
].join("\n");

describe("readCharacters", () => {
  test("reads each character's code points and trimmed, decoded names", () => {
    const characters = readCharacters(xml);
    expect(characters).toHaveLength(12);
    expect(characters[0]).toEqual({ codePoints: [0x1d400], latex: "\\mathbf{A}", unicodeMath: "\\mbfA" });
    expect(characters[1]).toEqual({ codePoints: [0x26], latex: "\\&", unicodeMath: "\\mathampersand" });
    expect(characters[10]).toEqual({ codePoints: [0x2242, 0x338], latex: "\\NotEqualTilde", unicodeMath: undefined });
  });
});

describe("generate", () => {
  test("gives the exact table", () => {
    expect(generate(xml, aliases, "aliases.tsv")).toBe(expected);
  });

  test("drops argument forms and Elsevier's names", () => {
    const table = generate(xml, "", "aliases.tsv");
    expect(table).not.toContain("\\mathbf");
    expect(table).not.toContain("\\&");
    expect(table).not.toContain("{_\\ast}");
    expect(table).not.toContain("\\not");
    expect(table).not.toContain("\\Elzxh");
  });

  test("gives a command naming two characters both, the classic one first", () => {
    const lines = generate(xml, "", "aliases.tsv").split("\n");
    expect(lines.filter((line) => line.startsWith("\\ast\t"))).toEqual(["\\ast\t*", "\\ast\t∗"]);
  });

  test("fails on an alias for a character unicode.xml lacks", () => {
    expect(() => generate(xml, "\\to\tU+2192\n\\snowman\tU+2603\n", "aliases.tsv")).toThrow(
      "aliases.tsv:2: U+2603 is not in unicode.xml",
    );
  });

  test("fails on an alias unicode.xml already uses as a name", () => {
    expect(() => generate(xml, "\\ast\tU+2217\n", "aliases.tsv")).toThrow(
      "aliases.tsv:1: \\ast is already a name in unicode.xml",
    );
    expect(() => generate(xml, "\\Elzxh\tU+0127\n", "aliases.tsv")).toThrow(
      "aliases.tsv:1: \\Elzxh is already a name in unicode.xml",
    );
  });
});

describe("parseAliases", () => {
  test("skips comments and blank lines", () => {
    expect(parseAliases(aliases, "aliases.tsv")).toEqual([
      { line: 2, command: "\\to", codePoint: 0x2192 },
      { line: 4, command: "\\emptyset", codePoint: 0x2205 },
      { line: 5, command: "\\neq", codePoint: 0x2260 },
    ]);
  });

  test("rejects a line that isn't a command and a code point", () => {
    expect(() => parseAliases("\\to U+2192\n", "aliases.tsv")).toThrow("aliases.tsv:1: expected \\command<TAB>U+XXXX");
  });
});

describe("the shipped aliases", () => {
  test("are the 24 the spec lists", () => {
    const shipped = parseAliases(
      readFileSync(fileURLToPath(new URL("aliases.tsv", import.meta.url)), "utf8"),
      "aliases.tsv",
    );
    expect(shipped.map((alias) => `${alias.command} ${String.fromCodePoint(alias.codePoint)}`)).toEqual([
      "\\to →",
      "\\gets ←",
      "\\le ≤",
      "\\ge ≥",
      "\\neq ≠",
      "\\iff ⟺",
      "\\implies ⟹",
      "\\impliedby ⟸",
      "\\land ∧",
      "\\lor ∨",
      "\\owns ∋",
      "\\dots …",
      "\\lvert |",
      "\\rvert |",
      "\\lVert ‖",
      "\\rVert ‖",
      "\\emptyset ∅",
      "\\hbar ℏ",
      "\\triangle △",
      "\\Box □",
      "\\Diamond ◇",
      "\\leadsto ⇝",
      "\\qed ∎",
      "\\degree °",
    ]);
  });
});

describe("cli.ts", () => {
  test("writes the table to standard output", () => {
    const dir = mkdtempSync(join(tmpdir(), "latex-table-"));
    const aliasesPath = join(dir, "aliases.tsv");
    writeFileSync(aliasesPath, aliases);
    const cli = fileURLToPath(new URL("cli.ts", import.meta.url));

    const result = spawnSync(process.execPath, [cli, fixture, aliasesPath], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expected);
  });

  test("reports an alias failure and exits 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "latex-table-"));
    const aliasesPath = join(dir, "aliases.tsv");
    writeFileSync(aliasesPath, "\\snowman\tU+2603\n");
    const cli = fileURLToPath(new URL("cli.ts", import.meta.url));

    const result = spawnSync(process.execPath, [cli, fixture, aliasesPath], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`${aliasesPath}:1: U+2603 is not in unicode.xml\n`);
  });
});
