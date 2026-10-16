// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type * as Protocol from "../../packages/protocol/src/index.ts";

type ProtocolApi = Pick<typeof Protocol, "decodeValue" | "decodeSettingsMetadata" | "encodeSettingsMetadata">;
interface Bytes {
  type: string;
  bytes: string;
}
interface RawMetadata {
  schemas: Array<{
    id: string;
    paths: string[];
    keys: Array<{
      name: string;
      type: string;
      default: Bytes;
      summary?: string;
      description?: string;
      range?: { min: Bytes; max: Bytes };
      choices?: string[];
    }>;
  }>;
}
// patterns gives relocatable schemas, by id, the pattern their paths match.
export function convertMetadata(
  raw: RawMetadata,
  protocol: ProtocolApi,
  patterns: Readonly<Record<string, string>> = {},
): Protocol.SettingsMetadataJson {
  for (const id of Object.keys(patterns))
    if (!raw.schemas.some((schema) => schema.id === id)) throw new Error(`a pattern names ${id}, which isn't listed`);

  const decode = (value: Bytes) => protocol.decodeValue(value.type, Buffer.from(value.bytes, "base64"));
  const encoded = protocol.encodeSettingsMetadata({
    schemas: raw.schemas
      .map((schema) => ({
        ...schema,
        ...(patterns[schema.id] === undefined ? {} : { pattern: patterns[schema.id]! }),
        keys: schema.keys
          .map(({ default: value, range, ...key }) => ({
            ...key,
            default: decode(value),
            ...(range ? { range: { min: decode(range.min), max: decode(range.max) } } : {}),
          }))
          .sort((a, b) => a.name.localeCompare(b.name, "en")),
      }))
      .sort((a, b) => a.id.localeCompare(b.id, "en")),
  });

  // Decoded as a page decodes it, so a path its pattern misses fails the build.
  protocol.decodeSettingsMetadata(encoded);
  return encoded;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [entry, input, output, patterns] = process.argv.slice(2);
  if (!entry || !input || !output)
    throw new Error("usage: metadata.ts PROTOCOL.js RAW.json OUTPUT.json [PATTERNS.json]");
  const protocol = (await import(pathToFileURL(entry).href)) as ProtocolApi;
  const converted = convertMetadata(
    JSON.parse(readFileSync(input, "utf8")),
    protocol,
    patterns === undefined ? {} : JSON.parse(readFileSync(patterns, "utf8")),
  );
  writeFileSync(output, `${JSON.stringify(converted, null, 2)}\n`);
}
