// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { generateUSHeader } from "./us-c.ts";
import { usVectors } from "./us-vectors.ts";

const dom = `DOM_CODE(0x070004, 0x001e, 0x0026, 0x001e, 0x0000, "KeyA", US_A), // aA
DOM_CODE(0x070059, 0x004f, 0x0057, 0x004f, 0x0053, "Numpad1", NUMPAD1), // +End`;

test("flags letters and keypad keys and sorts by code", () => {
  const header = generateUSHeader("[[79,[[65436,0],[65457,49]]],[30,[[97,97],[65,65]]]]", dom);
  expect(header.indexOf("{30, US_KEY_LETTER, 0x61, 0x41},")).toBeLessThan(
    header.indexOf("{79, US_KEY_KEYPAD, 0xff9c, 0xffb1},"),
  );
});

test("one-level keys have no upper keysym", () =>
  expect(generateUSHeader("[[1,[[65307,27]]]]", dom)).toContain("{1, 0, 0xff1b, 0x0},"));

test("vectors cover every modifier combination, with Mod5 ignored", () => {
  const path = process.env["IBUS_WEB_DOM_CODES"];
  if (!path) throw new Error("IBUS_WEB_DOM_CODES is required");
  const lines = usVectors(readFileSync(path, "utf8")).trim().split("\n");
  expect(lines).toEqual(expect.arrayContaining(["30 0 97", "30 1 65", "30 2 65", "30 3 97", "30 129 65"]));
  expect(lines).toEqual(expect.arrayContaining(["79 0 65436", "79 16 65457", "79 17 65457"]));
});
