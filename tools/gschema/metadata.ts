// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type * as Protocol from "../../packages/protocol/src/index.ts";

type ProtocolApi = Pick<typeof Protocol, "decodeValue" | "encodeSettingsMetadata">;
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
export function convertMetadata(raw: RawMetadata, protocol: ProtocolApi): Protocol.SettingsMetadataJson {
  const decode = (value: Bytes) => protocol.decodeValue(value.type, Buffer.from(value.bytes, "base64"));
  return protocol.encodeSettingsMetadata({
    schemas: raw.schemas
      .map((schema) => ({
        ...schema,
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
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [entry, input, output] = process.argv.slice(2);
  if (!entry || !input || !output) throw new Error("usage: metadata.ts PROTOCOL.js RAW.json OUTPUT.json");
  const protocol = (await import(pathToFileURL(entry).href)) as ProtocolApi;
  writeFileSync(
    output,
    `${JSON.stringify(convertMetadata(JSON.parse(readFileSync(input, "utf8")), protocol), null, 2)}\n`,
  );
}
