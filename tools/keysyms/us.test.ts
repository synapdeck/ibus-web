// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { generateUS } from "./us.ts";
import { usLevels } from "../../packages/core/src/keys/us.generated.ts";
import { codepointForKeysym } from "../../packages/core/src/keys/keysyms.generated.ts";
test("generator retains resolved levels", () =>
  expect(generateUS("[[34,[[103,103],[71,71]]]]")).toContain("[34,[[103,103],[71,71]]]"));
test("pinned libxkbcommon levels and Unicode pairs", () => {
  const path = process.env["IBUS_WEB_XKB_EXPORT"];
  if (!path) throw new Error("IBUS_WEB_XKB_EXPORT is required");
  const rows = JSON.parse(readFileSync(path, "utf8")) as [number, [number, number][]][];
  for (const [code, levels] of rows) {
    expect(usLevels(code)).toEqual(levels);
    // XF86 phone symbols belong to XF86keysym.h, outside the keysymdef.h Unicode table.
    for (const [sym, cp] of levels) if (cp && sym < 0x10000000) expect(codepointForKeysym(sym)).toBe(cp);
  }
  expect(usLevels(34)).toEqual([
    [103, 103],
    [71, 71],
  ]);
  expect(usLevels(79)?.map((x) => x[0])).toEqual([0xff9c, 0xffb1]);
});

test("central XKB source notice matches the pinned input byte-for-byte", () => {
  const notice = readFileSync(new URL("../../LICENSES/LicenseRef-xkeyboard-config.txt", import.meta.url), "utf8");
  expect(notice).toContain("Permission to use");
  expect(notice).toBe(readFileSync(process.env["IBUS_WEB_XKB_NOTICE"]!, "utf8"));
});
