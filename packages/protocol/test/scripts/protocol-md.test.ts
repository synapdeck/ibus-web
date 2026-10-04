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
  it("documents wire encoding, malformed requests, padding, ic 0 and page-relative candidate clicks", () => {
    const output = renderProtocolMd();
    expect(output).toContain("Header fields and GVariant payloads are little-endian.");
    expect(output).toContain("A request is 8 bytes of header (`kind`, `flags`, `ic`)");
    expect(output).toContain("a request of the header alone is malformed and `ibusweb_dispatch` returns -EBADMSG");
    expect(output).toContain("zero-padded to a multiple of 8 bytes.");
    expect(output).toContain("the empty tuple `()` is one zero byte");
    expect(output).toContain("`Log` and `SettingWritten` records belong to no input context: their `ic` is 0.");
    expect(output).toContain("`CONTINUATION` (`0x0001`) is the only flag");
    expect(output).toContain("Page-relative position of the clicked candidate on the visible lookup table page.");
  });

  it("describes the key event reply as ibusweb_dispatch's return value", () => {
    const section = renderProtocolMd().split("### ProcessKeyEvent\n\n")[1]!.split("\n\n### ")[0]!;
    expect(section).toContain(
      "Reply: `ibusweb_dispatch` returns 1 if the engine handled the key and 0 if not; the reply is that return value, not a GVariant payload.",
    );
    expect(section).not.toContain("Reply: `b`");
  });
});
