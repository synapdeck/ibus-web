// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { pathToFileURL } from "node:url";
import { Schema, SchemaAST } from "effect";
import {
  framing,
  type HeaderField,
  IBusAttribute,
  IBusAttrList,
  IBusText,
  IBusLookupTable,
  IBusProperty,
  IBusPropList,
  OutputRecord,
  PROTOCOL_VERSION,
  RECORD_CONTINUATION,
  recordKinds,
  Request,
  requestKinds,
  signatureOf,
} from "../src/index.ts";

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function table(headings: readonly string[], rows: readonly (readonly string[])[]): string {
  return [headings, headings.map(() => "---"), ...rows].map((row) => `| ${row.map(cell).join(" | ")} |`).join("\n");
}

function renderHeader(name: string, fields: readonly HeaderField[]): string {
  return `## ${name} header\n\n${table(
    ["Field", "Width (bytes)", "Description"],
    fields.map((field) => [`\`${field.name}\``, String(field.width), field.description]),
  )}`;
}

function ibusReference(ast: SchemaAST.AST): string | undefined {
  if (ast._tag === "Suspend") return ibusReference(ast.thunk());
  const name = ast.annotations?.ibusType;
  if (name) return `[${name}](#${name.toLowerCase()})`;
  if (ast._tag === "Arrays" && ast.rest.length === 1) {
    const element = ibusReference(ast.rest[0]!);
    return element ? `${element}[]` : undefined;
  }
  return undefined;
}

function fieldType(ast: SchemaAST.AST): string {
  const reference = ibusReference(ast);
  // A field occupies one member slot; serializables in that slot use variants.
  const signature = signatureOf(Schema.Struct({ field: Schema.make(ast) })).slice(1, -1);
  return `\`${signature}\`${reference ? ` (${reference})` : ""}`;
}

function renderFields(schema: Schema.Top): string {
  const ast = schema.ast;
  if (ast._tag !== "Declaration" || ast.typeParameters[0]?._tag !== "Objects") {
    throw new Error("Expected a class with object fields");
  }
  const rows: string[][] = [];
  const name = ast.annotations?.ibusType;
  if (name) rows.push(["`name`", "`s`", `Serializable type name: \`${name}\`.`]);
  for (const field of ast.typeParameters[0].propertySignatures) {
    if (field.name === "_tag") continue;
    rows.push([`\`${String(field.name)}\``, fieldType(field.type), SchemaAST.resolveDescription(field.type) ?? ""]);
  }
  return table(["Name", "GVariant type", "Description"], rows);
}

function renderMessages(
  title: string,
  kinds: ReadonlyMap<string, number>,
  schemas: Readonly<Record<string, Schema.Top>>,
): string {
  const sections = Array.from(kinds, ([name, kind]) => {
    const schema = schemas[name];
    if (!schema)
      return `### ${name}\n\nKind: **${kind}**. Reserved for the host; no payload schema or signature is defined.`;
    const description = SchemaAST.resolveDescription(schema.ast);
    const reply = schema.ast.annotations?.reply;
    return [
      `### ${name}`,
      `Kind: **${kind}**. Signature: \`${signatureOf(schema)}\`.`,
      description,
      reply ? `Reply: \`${reply}\` (0 or 1).` : undefined,
      renderFields(schema),
    ]
      .filter((section) => section !== undefined)
      .join("\n\n");
  });
  return `## ${title}\n\n${sections.join("\n\n")}`;
}

export function renderProtocolMd(): string {
  const types = [IBusAttribute, IBusAttrList, IBusText, IBusLookupTable, IBusProperty, IBusPropList];
  const sections = [
    "<!-- SPDX-FileCopyrightText: 2026 Synapdeck, Inc.\nSPDX-License-Identifier: MIT OR Apache-2.0 -->",
    "<!-- Generated from @ibus-web/protocol's schemas by `nix run .#write-files`; edit those, not this file. -->",
    "# ibus-web protocol",
    `Protocol version: **${PROTOCOL_VERSION}**.`,
    renderHeader("Request", framing.request),
    renderHeader("Record", framing.record),
    `Record flag \`CONTINUATION\`: \`0x${RECORD_CONTINUATION.toString(16).padStart(4, "0")}\`. Only the host sets this flag when fragmenting records.`,
    renderMessages("Requests", requestKinds, Request.cases),
    renderMessages("Records", recordKinds, OutputRecord.cases),
    "## IBus types",
    "Serializable tuples begin with their type name and attachments. Nested serializables occupy GVariant variant (`v`) slots.",
    ...types.map(
      (schema) =>
        `### ${schema.ast.annotations?.ibusType}\n\nSignature: \`${signatureOf(schema)}\`.\n\n${renderFields(schema)}`,
    ),
  ];
  return `${sections.join("\n\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(renderProtocolMd());
}
