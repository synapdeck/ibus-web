// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, it } from "vitest";
import { renderProtocolH } from "../../scripts/protocol-h.ts";

type MessageFixture = readonly [name: string, kind: number, signature: string];

const requests: readonly MessageFixture[] = [
  ["INIT", 1, "(ua{sa{sv}})"],
  ["CREATE_ENGINE", 2, "(s)"],
  ["DESTROY_ENGINE", 3, "()"],
  ["SETTING_CHANGED", 4, "(ssv)"],
  ["PROCESS_KEY_EVENT", 16, "(uuu)"],
  ["FOCUS_IN", 17, "()"],
  ["FOCUS_OUT", 18, "()"],
  ["RESET", 19, "()"],
  ["ENABLE", 20, "()"],
  ["DISABLE", 21, "()"],
  ["SET_CURSOR_LOCATION", 22, "(iiii)"],
  ["SET_CAPABILITIES", 23, "(u)"],
  ["PAGE_UP", 24, "()"],
  ["PAGE_DOWN", 25, "()"],
  ["CURSOR_UP", 26, "()"],
  ["CURSOR_DOWN", 27, "()"],
  ["CANDIDATE_CLICKED", 28, "(uuu)"],
  ["PROPERTY_ACTIVATE", 29, "(su)"],
  ["SET_SURROUNDING_TEXT", 30, "(vuu)"],
  ["SET_CONTENT_TYPE", 31, "(uu)"],
];
const records: readonly MessageFixture[] = [
  ["COMMIT_TEXT", 1, "(v)"],
  ["UPDATE_PREEDIT_TEXT", 2, "(vubu)"],
  ["UPDATE_AUXILIARY_TEXT", 3, "(vb)"],
  ["UPDATE_LOOKUP_TABLE", 4, "(vb)"],
  ["SHOW_PREEDIT_TEXT", 5, "()"],
  ["HIDE_PREEDIT_TEXT", 6, "()"],
  ["SHOW_AUXILIARY_TEXT", 7, "()"],
  ["HIDE_AUXILIARY_TEXT", 8, "()"],
  ["SHOW_LOOKUP_TABLE", 9, "()"],
  ["HIDE_LOOKUP_TABLE", 10, "()"],
  ["REGISTER_PROPERTIES", 11, "(v)"],
  ["UPDATE_PROPERTY", 12, "(v)"],
  ["FORWARD_KEY_EVENT", 13, "(uuu)"],
  ["DELETE_SURROUNDING_TEXT", 14, "(iu)"],
  ["REQUIRE_SURROUNDING_TEXT", 15, "()"],
  ["SETTING_WRITTEN", 32, "(ssv)"],
  ["LOG", 33, "(uss)"],
];

describe("generated C wire header", () => {
  it("keeps the installed header's license and generation notice", () => {
    expect(renderProtocolH()).toMatch(
      /^\/\* SPDX-FileCopyrightText: 2026 Synapdeck, Inc\.\n \* SPDX-License-Identifier: LGPL-2\.1-or-later \*\/\n\/\* Generated from @ibus-web\/protocol's schemas by `nix run \.#write-files`;/,
    );
  });

  it("preserves framing types, field order, version and flag", () => {
    const header = renderProtocolH();
    const declarations = header.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
    expect(header).toContain("#define IBUSWEB_PROTOCOL_VERSION 1");
    expect(header).toContain("#define IBUSWEB_RECORD_CONTINUATION 0x0001");
    expect(declarations).toContain(
      "typedef struct { uint16_t kind; uint16_t flags; uint32_t ic; } IBusWebRequestHeader;",
    );
    expect(declarations).toContain(
      "typedef struct { uint32_t seq; uint32_t ic; uint16_t kind; uint16_t flags; uint32_t len; } IBusWebRecordHeader;",
    );
  });

  for (const [prefix, messages] of [
    ["REQ", requests],
    ["REC", records],
  ] as const) {
    it.each(messages)(`preserves ${prefix} %s kind %i and signature %s`, (name, kind, signature) => {
      const header = renderProtocolH();
      expect(header).toContain(`IBUSWEB_${prefix}_${name} = ${kind},`);
      expect(header).toContain(`{IBUSWEB_${prefix}_${name}, "${signature}"}`);
    });
  }

  it("reserves Crashed without assigning a payload signature", () => {
    const header = renderProtocolH();
    expect(header).toContain("IBUSWEB_REC_CRASHED = 34,");
    expect(header).not.toContain("{IBUSWEB_REC_CRASHED,");
  });

  it("documents schema fields, descriptions and the key event reply", () => {
    const header = renderProtocolH();
    expect(header).toContain("(uuu) keyval, keycode, state → reply 0 or 1");
    expect(header).toContain("Process a key event and reply whether the engine handled it.");
    expect(header).toContain("Reserved request flags; must be zero.");
    expect(header).toContain("GSettings schema id containing the changed key.");
  });
});
