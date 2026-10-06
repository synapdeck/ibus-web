// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";
import { expect, it } from "vitest";
import { SettingsMetadata, decodeSettingsMetadata, encodeSettingsMetadata } from "../src/index.ts";

const metadata = (type = "s", value: unknown = { _tag: "s", value: "2" }) => ({
  schemas: [{ id: "org.test", path: "/org/test/", keys: [{ name: "keyboard", type, default: value }] }],
});
it("decodes settings metadata and round-trips bigint defaults through JSON", () => {
  expect(Schema.decodeUnknownSync(SettingsMetadata)(metadata())).toEqual(metadata());
  const value = metadata("t", { _tag: "t", value: "18446744073709551615" });
  const decoded = decodeSettingsMetadata(value);
  expect(decoded.schemas[0]!.keys[0]!.default).toEqual({ _tag: "t", value: 18446744073709551615n });
  expect(JSON.parse(JSON.stringify(encodeSettingsMetadata(decoded)))).toEqual(value);
});
it.each(["", "relative/", "/org//test/", "/org/test", "/org/../test/"])("rejects invalid path %s", (path) => {
  const value = metadata();
  value.schemas[0]!.path = path;
  expect(() => decodeSettingsMetadata(value)).toThrow();
});
it("rejects values inconsistent with their declared type", () => {
  expect(() => decodeSettingsMetadata(metadata("i"))).toThrow();
  expect(() => decodeSettingsMetadata(metadata("y", { _tag: "y", value: 256 }))).toThrow();
});
it("rejects duplicate schema ids and keys", () => {
  const value = metadata();
  expect(() => decodeSettingsMetadata({ schemas: [...value.schemas, ...value.schemas] })).toThrow();
  value.schemas[0]!.keys.push(value.schemas[0]!.keys[0]!);
  expect(() => decodeSettingsMetadata(value)).toThrow();
});
it.each([Infinity, -Infinity, NaN, -0])("round-trips special double %s through JSON", (number) => {
  const decoded = {
    schemas: [
      {
        id: "org.test",
        path: "/org/test/",
        keys: [{ name: "double", type: "d", default: { _tag: "d" as const, value: number } }],
      },
    ],
  };
  const json = JSON.parse(JSON.stringify(encodeSettingsMetadata(decoded)));
  const result = decodeSettingsMetadata(json).schemas[0]!.keys[0]!.default;
  expect(result).toEqual({ _tag: "d", value: number });
});
