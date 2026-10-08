// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { chromiumNotice, keysymNotice } from "./notices.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("notice extraction removes only source comment syntax", () => {
  expect(keysymNotice("/*****\nCopyright Example\n\n  All Rights Reserved\n\n*****/\n#define OTHER 1\n")).toBe(
    "Copyright Example\n\n  All Rights Reserved\n\n",
  );
  expect(chromiumNotice("// Copyright Example\n//\n//    * Retain this bullet.\n// Disclaimer.\n")).toBe(
    "Copyright Example\n\n   * Retain this bullet.\nDisclaimer.\n",
  );
});

test("canonical notices preserve the complete pinned upstream wording", () => {
  const x11 = readFileSync(process.env["IBUS_WEB_KEYSYMDEF"]!, "utf8");
  const chromium = readFileSync(process.env["IBUS_WEB_CHROMIUM_LICENSE"]!, "utf8");
  const x11Notice = keysymNotice(x11);
  const chromiumText = chromiumNotice(chromium);
  expect(readFileSync(join(root, "NOTICES/keysymdef.txt"), "utf8")).toBe(x11Notice);
  expect(readFileSync(join(root, "NOTICES/chromium.txt"), "utf8")).toBe(chromiumText);
  // Restoring only the pinned comment delimiters recovers every original byte.
  expect(
    "/***********************************************************\n" +
      x11Notice +
      "******************************************************************/",
  ).toBe(x11.slice(0, x11.indexOf("*/") + 2));
  expect(
    chromiumText
      .split("\n")
      .slice(0, -1)
      .map((line) => (line ? `// ${line}` : "//"))
      .join("\n") + "\n",
  ).toBe(chromium);
  expect(chromiumText).toContain("Copyright 2015 The Chromium Authors");
});
