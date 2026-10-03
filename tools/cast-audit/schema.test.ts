// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import { expect, test } from "vitest";

test("the referenced schema parses with the JSON language service's parser defaults", () => {
  const fixture = new URL("fixtures/allow.jsonc", import.meta.url);
  const config = parse(readFileSync(fixture, "utf8"), [], { allowTrailingComma: true });
  const errors: ParseError[] = [];
  parse(readFileSync(new URL(config.$schema, fixture), "utf8"), errors);
  expect(errors).toEqual([]);
});
