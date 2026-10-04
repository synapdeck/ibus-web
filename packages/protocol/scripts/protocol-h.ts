// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { pathToFileURL } from "node:url";
import type { Schema, SchemaAST } from "effect";
import {
  framing,
  type HeaderField,
  OutputRecord,
  PROTOCOL_VERSION,
  recordKinds,
  Request,
  requestKinds,
  signatureOf,
} from "../src/index.ts";
import { continuationFlag, framingNotes } from "./framing-notes.ts";

// The repository's .clang-format (LLVM style).
const columnLimit = 80;

// clang-format reflows a comment line past the column limit into the line after it, so comments
// arrive wrapped. Each paragraph starts its own line; `hang` indents its continuation lines, and
// an empty paragraph is a blank line.
function blockComment(paragraphs: readonly string[], indent: string, hang: string): string {
  const width = columnLimit - indent.length - " * ".length;
  const lines = paragraphs.flatMap((paragraph) => {
    if (paragraph === "") return [""];
    const wrapped: string[] = [];
    let line = "";
    for (const word of paragraph.split(" ")) {
      const prefix = wrapped.length === 0 ? "" : hang;
      if (line !== "" && prefix.length + line.length + 1 + word.length > width) {
        wrapped.push(prefix + line);
        line = word;
      } else {
        line = line === "" ? word : `${line} ${word}`;
      }
    }
    wrapped.push((wrapped.length === 0 ? "" : hang) + line);
    return wrapped;
  });
  const body = lines.map((line, index) => `${indent}${index === 0 ? "/*" : " *"}${line === "" ? "" : ` ${line}`}`);
  const last = body.at(-1)!;
  if (last.length + " */".length <= columnLimit) body[body.length - 1] = `${last} */`;
  else body.push(`${indent} */`);
  return body.join("\n");
}

function enumerator(prefix: string, name: string): string {
  return `${prefix}_${name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
}

function descriptionOf(ast: SchemaAST.AST): string | undefined {
  const description = ast.checks?.at(-1)?.annotations?.description ?? ast.annotations?.description;
  return typeof description === "string" ? description : undefined;
}

function renderHeader(name: string, fields: readonly HeaderField[]): string {
  const declarations = fields.map(
    (field) => `${blockComment([field.description], "  ", "  ")}\n  uint${field.width * 8}_t ${field.name};`,
  );
  return `typedef struct {\n${declarations.join("\n")}\n} ${name};`;
}

function messageComment(schema: Schema.Top): readonly string[] {
  const ast = schema.ast;
  if (ast._tag !== "Declaration" || ast.typeParameters[0]?._tag !== "Objects") {
    throw new Error("Expected a tagged message class with object fields");
  }
  const fields = ast.typeParameters[0].propertySignatures.filter((field) => field.name !== "_tag");
  const names = fields.map((field) => String(field.name));
  const reply = ast.annotations?.reply === "b" ? " → reply 0 or 1" : "";
  const signature = `${signatureOf(schema)}${names.length ? ` ${names.join(", ")}` : ""}${reply}`;
  const descriptions = fields.flatMap((field) => {
    const description = descriptionOf(field.type);
    return description ? [`${String(field.name)}: ${description}`] : [];
  });
  const description = descriptionOf(ast);
  return [signature, ...(description ? [description] : []), ...descriptions];
}

function renderEnum(
  name: string,
  prefix: string,
  kinds: ReadonlyMap<string, number>,
  schemas: Readonly<Record<string, Schema.Top>>,
): string {
  const entries = Array.from(kinds, ([message, kind]) => {
    const schema = schemas[message];
    const comment = schema ? messageComment(schema) : ["written by the host only"];
    return `${blockComment(comment, "  ", "  ")}\n  ${enumerator(prefix, message)} = ${kind},`;
  });
  return `enum ${name} {\n${entries.join("\n")}\n};`;
}

function renderSignatureFunction(
  name: string,
  prefix: string,
  kinds: ReadonlyMap<string, number>,
  schemas: Readonly<Record<string, Schema.Top>>,
): string {
  const entries = Array.from(kinds.keys()).flatMap((message) => {
    const schema = schemas[message];
    return schema ? [`      {${enumerator(prefix, message)}, "${signatureOf(schema)}"},`] : [];
  });
  return `static inline const char *${name}(uint16_t kind) {
  static const struct {
    uint16_t kind;
    const char *signature;
  } signatures[] = {
${entries.join("\n")}
  };
  for (size_t i = 0; i < sizeof signatures / sizeof signatures[0]; i++)
    if (signatures[i].kind == kind)
      return signatures[i].signature;
  return NULL;
}`;
}

export function renderProtocolH(): string {
  return `/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
${blockComment(["Generated from @ibus-web/protocol's schemas by `nix run .#write-files`; edit those, not this file."], "", "")}
#pragma once
#include <stddef.h>
#include <stdint.h>

#define IBUSWEB_PROTOCOL_VERSION ${PROTOCOL_VERSION}

${blockComment(
  framingNotes((text) => text).flatMap((note, index) => (index === 0 ? [note] : ["", note])),
  "",
  "",
)}

${renderHeader("IBusWebRequestHeader", framing.request)}

${renderHeader("IBusWebRecordHeader", framing.record)}
#define IBUSWEB_RECORD_CONTINUATION ${continuationFlag}

${renderEnum("IBusWebRequestKind", "IBUSWEB_REQ", requestKinds, Request.cases)}

${renderEnum("IBusWebRecordKind", "IBUSWEB_REC", recordKinds, OutputRecord.cases)}

${renderSignatureFunction("ibusweb_request_signature", "IBUSWEB_REQ", requestKinds, Request.cases)}

${renderSignatureFunction("ibusweb_record_signature", "IBUSWEB_REC", recordKinds, OutputRecord.cases)}
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(renderProtocolH());
}
