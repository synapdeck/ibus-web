// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, it } from "vitest";
import { renderProtocolMd } from "../../scripts/protocol-md.ts";
import { Request, OutputRecord, requestKinds, recordKinds, signatureOf } from "../../src/index.ts";

describe("protocol document", () => {
  it("documents licensing, framing, every message and serializable", () => {
    const document = renderProtocolMd();
    expect(document).toContain("<!-- SPDX-FileCopyrightText: 2026 Synapdeck, Inc.");
    expect(document).toContain(["SPDX-License-Identifier", "MIT OR Apache-2.0 -->"].join(": "));
    expect(document).toContain("Generated from @ibus-web/protocol's schemas");
    expect(document).toContain("Protocol version: **1**");
    expect(document).toContain("## Request header");
    expect(document).toContain("## Record header");
    expect(document).toContain("| Field | Width (bytes) | Description |");
    for (const [schemas, kinds] of [
      [Request.cases, requestKinds],
      [OutputRecord.cases, recordKinds],
    ] as const) {
      for (const [name, schema] of Object.entries(schemas)) {
        expect(document).toContain(
          `### ${name}\n\nKind: **${kinds.get(name)}**. Signature: \`${signatureOf(schema)}\``,
        );
        const section = document.split(`### ${name}\n\n`)[1]!.split("\n\n### ")[0]!;
        expect(section).toContain("| Name | GVariant type | Description |");
      }
    }
    expect(document).toContain("### Crashed\n\nKind: **34**. Reserved for the host");
    for (const name of [
      "IBusAttribute",
      "IBusAttrList",
      "IBusText",
      "IBusLookupTable",
      "IBusProperty",
      "IBusPropList",
    ]) {
      expect(document).toContain(`### ${name}`);
    }
    expect(document).toContain("| Name | GVariant type | Description |");
    expect(document).toContain("| `kind` | 2 | Request kind identifying the payload schema. |");
    expect(document).toContain("| `len` | 4 | Payload length in bytes, excluding the header and padding. |");
    expect(document).toContain("| `keyval` | `u` | Key symbol value. |");
    expect(document).toContain("| `text` | `v` ([IBusText](#ibustext)) |");
    expect(document).toContain("| `subProps` | `v` ([IBusPropList](#ibusproplist)) | Nested properties. |");
    expect(document).toContain("| `candidates` | `av` ([IBusText](#ibustext)[]) |");
    expect(document).toContain("| `name` | `s` | Serializable type name: `IBusText`. |");
  });
});
