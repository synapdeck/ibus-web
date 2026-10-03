// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { NewLineIndex } from "@microsoft/sarif";
import type { Region } from "@microsoft/sarif";
import Parser from "tree-sitter";
import C from "tree-sitter-c";
import Cpp from "tree-sitter-cpp";

export function castOperandName(source: string, region: Region, language: "c" | "cpp"): string | null {
  if (region.startLine === undefined || region.startColumn === undefined) {
    throw new Error("cast diagnostic must identify a source line and column");
  }

  const lines = new NewLineIndex(source);
  const lineStart = lines.startOffsetForLine(region.startLine);

  // Clang reports Unicode code points; the Node binding indexes UTF-16 strings.
  const prefix = Array.from(source.slice(lineStart))
    .slice(0, region.startColumn - 1)
    .join("");
  const offset = lineStart + prefix.length;

  const parser = new Parser();
  parser.setLanguage(language === "c" ? C : Cpp);

  const tree = parser.parse(source);
  let node: Parser.SyntaxNode | null = tree.rootNode.descendantForIndex(offset);
  while (node !== null && node.startIndex === offset) {
    if (node.type === "cast_expression") {
      const operand = node.childForFieldName("value");
      return operand?.type === "identifier" ? operand.text : null;
    }
    node = node.parent;
  }

  // A diagnostic at a macro expansion need not point to a literal cast.
  return null;
}
