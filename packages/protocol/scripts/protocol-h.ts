// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { pathToFileURL } from "node:url";
import type { Schema, SchemaAST } from "effect";
import {
  framing,
  type HeaderField,
  OutputRecord,
  PROTOCOL_VERSION,
  RECORD_CONTINUATION,
  recordKinds,
  Request,
  requestKinds,
  signatureOf,
} from "../src/index.ts";

function enumerator(prefix: string, name: string): string {
  return `${prefix}_${name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
}

function descriptionOf(ast: SchemaAST.AST): string | undefined {
  const description = ast.checks?.at(-1)?.annotations?.description ?? ast.annotations?.description;
  return typeof description === "string" ? description : undefined;
}

function renderHeader(name: string, fields: readonly HeaderField[]): string {
  const declarations = fields.map((field) => `  uint${field.width * 8}_t ${field.name}; /* ${field.description} */`);
  return `typedef struct {\n${declarations.join("\n")}\n} ${name};`;
}

function messageComment(schema: Schema.Top): string {
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
  return [signature, descriptionOf(ast), ...descriptions].filter(Boolean).join("\n * ");
}

function renderEnum(
  name: string,
  prefix: string,
  kinds: ReadonlyMap<string, number>,
  schemas: Readonly<Record<string, Schema.Top>>,
): string {
  const entries = Array.from(kinds, ([message, kind]) => {
    const schema = schemas[message];
    const comment = schema ? messageComment(schema) : "written by the host only";
    return `  /* ${comment} */\n  ${enumerator(prefix, message)} = ${kind},`;
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
/* Generated from @ibus-web/protocol's schemas by \`nix run .#write-files\`; edit those, not this file. */
#pragma once
#include <stddef.h>
#include <stdint.h>

#define IBUSWEB_PROTOCOL_VERSION ${PROTOCOL_VERSION}

/* Header fields and GVariant payloads use little-endian encoding.
 * Payloads must be in GVariant normal form.
 * Records are zero-padded to a total size that is a multiple of eight bytes.
 * An empty tuple payload () is one zero byte. */

${renderHeader("IBusWebRequestHeader", framing.request)}

${renderHeader("IBusWebRecordHeader", framing.record)}
#define IBUSWEB_RECORD_CONTINUATION 0x${RECORD_CONTINUATION.toString(16).padStart(4, "0")}

${renderEnum("IBusWebRequestKind", "IBUSWEB_REQ", requestKinds, Request.cases)}

${renderEnum("IBusWebRecordKind", "IBUSWEB_REC", recordKinds, OutputRecord.cases)}

${renderSignatureFunction("ibusweb_request_signature", "IBUSWEB_REQ", requestKinds, Request.cases)}

${renderSignatureFunction("ibusweb_record_signature", "IBUSWEB_REC", recordKinds, OutputRecord.cases)}
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(renderProtocolH());
}
