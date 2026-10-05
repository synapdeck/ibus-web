// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseDomCodes } from "./dom-codes.ts";
test("evdev is the second column; absent evdev and null names are omitted", () => {
  expect([
    ...parseDomCodes(`
 DOM_CODE(0x070004, 0x001e, 0x0026, 0x001e, 0x0000, "KeyA", US_A),
 DOM_CODE(0x000010, 0x0000, 0x0000, 0x0000, 0xffff, "Hyper", HYPER),
 DOM_CODE(0x01009b, 0x024f, 0x0257, 0x0000, 0xffff, NULL,
   ASSISTANT),
 // DOM_CODE(0x070005, 0x0030, 0x0038, 0x0030, 0x000b, "KeyB", US_B),
 `),
  ]).toEqual([["KeyA", 30]]);
});
test("pinned Chromium physical codes", () => {
  const source = process.env["IBUS_WEB_DOM_CODES"];
  if (source === undefined) throw new Error("IBUS_WEB_DOM_CODES is required");
  const codes = parseDomCodes(readFileSync(source, "utf8"));
  for (const [name, value] of [
    ["KeyA", 30],
    ["Lang1", 122],
    ["Lang2", 123],
    ["Space", 57],
  ] as const)
    expect(codes.get(name)).toBe(value);
});
