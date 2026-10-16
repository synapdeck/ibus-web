// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";
import { expect, test } from "vitest";
import {
  SettingsMetadata,
  decodeSettingsMetadata,
  encodeSettingsMetadata,
  settingsPatternMatches,
} from "../../src/index.ts";

const metadata = (type = "s", value: unknown = { _tag: "s", value: "2" }) => ({
  schemas: [{ id: "org.test", paths: ["/org/test/"], keys: [{ name: "keyboard", type, default: value }] }],
});

test("decodes settings metadata and round-trips bigint defaults through JSON", () => {
  expect(Schema.decodeUnknownSync(SettingsMetadata)(metadata())).toEqual(metadata());
  const value = metadata("t", { _tag: "t", value: "18446744073709551615" });
  const decoded = decodeSettingsMetadata(value);
  expect(decoded.schemas[0]!.keys[0]!.default).toEqual({ _tag: "t", value: 18446744073709551615n });
  expect(JSON.parse(JSON.stringify(encodeSettingsMetadata(decoded)))).toEqual(value);
});

test("decodes a schema at several paths", () => {
  const value = metadata();
  value.schemas[0]!.paths = ["/org/test/a/", "/org/test/b/"];
  expect(decodeSettingsMetadata(value).schemas[0]!.paths).toEqual(["/org/test/a/", "/org/test/b/"]);
});

test("decodes a schema whose paths a pattern covers", () => {
  const value = {
    schemas: [{ ...metadata().schemas[0]!, paths: ["/org/test/hi/inscript/", "/org/test/t/latn-post/"] }],
  };
  const patterned = { schemas: [{ ...value.schemas[0]!, pattern: "/org/test/{lang}/{name}/" }] };
  expect(decodeSettingsMetadata(patterned).schemas[0]!.pattern).toBe("/org/test/{lang}/{name}/");
  expect(() => decodeSettingsMetadata({ schemas: [{ ...value.schemas[0]!, pattern: "/org/test/{lang}/" }] })).toThrow(
    "doesn't match its pattern",
  );
  for (const pattern of ["/org/test/", "/org/test/{}/", "/org/{a/b}/", "org/{lang}/", "/org/test/{lang}"])
    expect(() => decodeSettingsMetadata({ schemas: [{ ...value.schemas[0]!, pattern }] }), pattern).toThrow();
});

test("a pattern's placeholder stands for one or more characters of one component", () => {
  expect(settingsPatternMatches("/org/{lang}-{name}/", "/org/hi-inscript/")).toBe(true);
  expect(settingsPatternMatches("/org/{lang}-{name}/", "/org/hi-in-script/")).toBe(true);
  expect(settingsPatternMatches("/org/{lang}-{name}/", "/org/hi-/")).toBe(false);
  expect(settingsPatternMatches("/org/{lang}/{name}/", "/org/hi/")).toBe(false);
  expect(settingsPatternMatches("/org/{lang}/{name}/", "/org/hi/inscript/variables/")).toBe(false);
  expect(settingsPatternMatches("/org.test/{name}/", "/orgxtest/a/")).toBe(false);
});

test.each(["", "relative/", "/org//test/", "/org/test", "/org/../test/"])("rejects invalid path %s", (path) => {
  const value = metadata();
  value.schemas[0]!.paths = [path];
  expect(() => decodeSettingsMetadata(value)).toThrow();
});

test("rejects a schema without paths", () => {
  const value = metadata();
  value.schemas[0]!.paths = [];
  expect(() => decodeSettingsMetadata(value)).toThrow();
});

test("rejects values inconsistent with their declared type", () => {
  expect(() => decodeSettingsMetadata(metadata("i"))).toThrow();
  expect(() => decodeSettingsMetadata(metadata("y", { _tag: "y", value: 256 }))).toThrow();
});

test("rejects duplicate schema ids, paths and keys", () => {
  const value = metadata();
  expect(() => decodeSettingsMetadata({ schemas: [...value.schemas, ...value.schemas] })).toThrow();
  expect(() =>
    decodeSettingsMetadata({ schemas: [...value.schemas, { ...value.schemas[0]!, id: "org.other" }] }),
  ).toThrow("duplicate settings paths");
  value.schemas[0]!.paths = ["/org/test/", "/org/test/"];
  expect(() => decodeSettingsMetadata(value)).toThrow("duplicate settings paths");
  value.schemas[0]!.paths = ["/org/test/"];
  value.schemas[0]!.keys.push(value.schemas[0]!.keys[0]!);
  expect(() => decodeSettingsMetadata(value)).toThrow();
});

test.each([Infinity, -Infinity, NaN, -0])("round-trips special double %s through JSON", (number) => {
  const decoded = {
    schemas: [
      {
        id: "org.test",
        paths: ["/org/test/"],
        keys: [{ name: "double", type: "d", default: { _tag: "d" as const, value: number } }],
      },
    ],
  };
  const json = JSON.parse(JSON.stringify(encodeSettingsMetadata(decoded)));
  const result = decodeSettingsMetadata(json).schemas[0]!.keys[0]!.default;
  expect(result).toEqual({ _tag: "d", value: number });
});
