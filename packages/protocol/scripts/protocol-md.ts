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
  recordKinds,
  Request,
  requestKinds,
  signatureOf,
} from "../src/index.ts";
import {
  Word,
  wordDescriptions,
  HEADER_BYTES,
  DEFAULT_SLOT_BYTES,
  DEFAULT_RING_BYTES,
} from "../src/transport/layout.ts";
import { framingNotes } from "./framing-notes.ts";

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
  const objects = ast._tag === "Declaration" ? ast.typeParameters[0] : ast;
  if (objects?._tag !== "Objects") {
    throw new Error("Expected a struct or class with object fields");
  }
  const rows: string[][] = [];
  const name = ast.annotations?.ibusType;
  if (name) rows.push(["`name`", "`s`", `Serializable type name: \`${name}\`.`]);
  for (const field of objects.propertySignatures) {
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
      reply === "b"
        ? "Reply: `ibusweb_dispatch` returns 1 if the engine handled the key and 0 if not; the reply is that return value, not a GVariant payload."
        : undefined,
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
    ...framingNotes((text) => `\`${text}\``),
    "## Transport",
    `Shared memory contains a ${HEADER_BYTES}-byte control header, a ${DEFAULT_SLOT_BYTES}-byte request slot and a ${DEFAULT_RING_BYTES}-byte ring by default. Slot and ring sizes are multiples of 8; the ring is a power of two of at least 64 bytes.`,
    table(
      ["Index", "Word", "Written by", "Meaning"],
      Object.entries(Word).map(([name, index]) => {
        const field = wordDescriptions[name as keyof typeof Word];
        return [String(index), `\`${name}\``, field.writer, field.description];
      }),
    ),
    "Ring counters count bytes modulo 2³²; free space is ringBytes minus the unsigned difference of ringWrite and ringRead. Bytes are published before ringWrite advances. Records have a 16-byte header and zero padding to multiples of 8 and never wrap. A tail shorter than 16 bytes is skipped; otherwise a padding record fills an unusable tail (kind, seq, ic and flags zero; len equals tail bytes minus 16). Kind 0 is reserved in both directions.",
    "When a record exceeds available space, the writer emits the largest fitting fragment with at least 8 payload bytes. All fragments share seq, ic and kind and remain consecutive, apart from padding. CONTINUATION is set on every fragment except the last. The reader concatenates payloads and returns one framed record with flags zero. On full, resume with the same immutable record; needBytes is the minimum free space needed for progress, including a required tail skip. After consuming bytes the reader clears ringWaiting and bumps and notifies wake if a writer was waiting.",
    "Host records use seq and ic zero and do not advance replyOutSeq. Runtime sequences skip zero on wrap. The control state is authoritative for crashes; Crashed is a best-effort host record.",
    renderHeader("Request", framing.request),
    renderHeader("Record", framing.record),
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
