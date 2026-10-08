// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The LaTeX engine's table, from W3C xml-entities' unicode.xml and our
// aliases. unicode.xml is regular enough to scan with patterns: each
// character is one <character> element with a U-prefixed hexadecimal id, and
// the names are text-only elements inside it.

export interface Character {
  codePoints: number[];
  latex: string | undefined;
  unicodeMath: string | undefined;
}

export interface Alias {
  line: number;
  command: string;
  codePoint: number;
}

const frontmatter = [
  "# LaTeX commands to Unicode, generated from W3C xml-entities' unicode.xml,",
  "# which is under the W3C Software Notice and License.",
  "name = LaTeX",
  "languages = und-Zmth",
  "mode = command",
  "trigger = \\",
  "---",
];

// Commands with arguments, such as \mathbb{A}, can't be typed as one key.
const bareCommand = /^\\[A-Za-z]+$/;

const namedEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[a-z]+);/g, (entity, name: string) => {
    if (name.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    }
    return namedEntities[name] ?? entity;
  });
}

function element(body: string, pattern: RegExp): string | undefined {
  const text = pattern.exec(body)?.[1];
  return text === undefined ? undefined : decodeEntities(text).trim();
}

export function readCharacters(xml: string): Character[] {
  const characters: Character[] = [];
  for (const [, attributes = "", body = ""] of xml.matchAll(/<character\b([^>]*)>([\s\S]*?)<\/character>/g)) {
    const id = /\bid="U([0-9A-F]+(?:-[0-9A-F]+)*)"/.exec(attributes)?.[1];
    if (id === undefined) {
      throw new Error(`unicode.xml: a character without a code point id: <character${attributes}>`);
    }
    characters.push({
      codePoints: id.split("-").map((hex) => Number.parseInt(hex, 16)),
      latex: element(body, /<latex>([\s\S]*?)<\/latex>/),
      unicodeMath: element(body, /<mathlatex set="unicode-math">([\s\S]*?)<\/mathlatex>/),
    });
  }
  return characters;
}

export function parseAliases(text: string, path: string): Alias[] {
  const aliases: Alias[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "" || line.startsWith("#")) {
      continue;
    }
    const match = /^(\\[A-Za-z]+)\tU\+([0-9A-F]{4,6})$/.exec(line);
    if (match === null) {
      throw new Error(`${path}:${index + 1}: expected \\command<TAB>U+XXXX`);
    }
    aliases.push({ line: index + 1, command: match[1]!, codePoint: Number.parseInt(match[2]!, 16) });
  }
  return aliases;
}

function compareCodePoints(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return a[i]! - b[i]!;
    }
  }
  return a.length - b.length;
}

function escapeOutput(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\n", "\\n");
}

function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

// Classic names, then unicode-math names, each in code point order, then the
// aliases in file order. A name that both give for one character appears
// once, as a classic name.
export function generate(xml: string, aliasesText: string, aliasesPath: string): string {
  const characters = readCharacters(xml).toSorted((a, b) => compareCodePoints(a.codePoints, b.codePoints));
  const names = new Set(characters.flatMap((character) => [character.latex, character.unicodeMath]));
  const single = new Set(
    characters.filter((character) => character.codePoints.length === 1).map((character) => character.codePoints[0]),
  );

  const lines = [...frontmatter];
  const seen = new Set<string>();
  const add = (command: string, text: string) => {
    const line = `${command}\t${escapeOutput(text)}`;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  };

  const groups = [
    ["# Classic LaTeX names", "latex"],
    ["# unicode-math names", "unicodeMath"],
  ] as const;
  for (const [comment, field] of groups) {
    lines.push("", comment);
    for (const character of characters) {
      const name = character[field];
      // Names for Elsevier's fonts, which no LaTeX user types.
      if (name !== undefined && bareCommand.test(name) && !name.startsWith("\\El")) {
        add(name, String.fromCodePoint(...character.codePoints));
      }
    }
  }

  lines.push("", "# Common spellings unicode.xml doesn't name");
  for (const alias of parseAliases(aliasesText, aliasesPath)) {
    if (!single.has(alias.codePoint)) {
      throw new Error(`${aliasesPath}:${alias.line}: ${formatCodePoint(alias.codePoint)} is not in unicode.xml`);
    }
    if (names.has(alias.command)) {
      throw new Error(`${aliasesPath}:${alias.line}: ${alias.command} is already a name in unicode.xml`);
    }
    add(alias.command, String.fromCodePoint(alias.codePoint));
  }

  return `${lines.join("\n")}\n`;
}
