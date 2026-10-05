// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { IBusCapability, IBusModifier, IBusInputPurpose, IBusInputHints } from "../../src/ibus/flags.ts";
test("every client flag matches the vendored native IBus headers", () => {
  const constants = process.env["IBUS_WEB_FLAGS"];
  if (constants === undefined) throw new Error("IBUS_WEB_FLAGS is required");
  expect({ IBusCapability, IBusModifier, IBusInputPurpose, IBusInputHints }).toEqual(
    JSON.parse(readFileSync(constants, "utf8")),
  );
});
