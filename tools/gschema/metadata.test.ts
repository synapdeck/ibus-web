// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import * as protocol from "../../packages/protocol/src/index.ts";
import { convertMetadata } from "./metadata.ts";

const fixture = process.env["IBUS_WEB_SETTINGS_FIXTURE"];
if (!fixture) throw new Error("IBUS_WEB_SETTINGS_FIXTURE is required");
const paths: {
  helper: string;
  schemas: string;
  native: string;
  hangul: string;
  settingsFromAttrs: string;
  settingsFromFile: string;
} = JSON.parse(readFileSync(fixture, "utf8"));
const raw = JSON.parse(
  execFileSync(process.execPath, [paths.helper, paths.schemas, "org.test.Metadata"], { encoding: "utf8" }),
);
const converted = convertMetadata(raw, protocol);
const decoded = protocol.decodeSettingsMetadata(JSON.parse(JSON.stringify(converted)));
const keys = Object.fromEntries(decoded.schemas[0]!.keys.map((key) => [key.name, key]));
test("uses identical pinned native and WASM GLib normal-form bytes", () => {
  expect(raw).toEqual(
    JSON.parse(
      execFileSync(paths.native, [paths.schemas, "org.test.Metadata"], {
        encoding: "utf8",
        env: { ...process.env, LLVM_PROFILE_FILE: "/dev/null" },
      }),
    ),
  );
});
test("decodes each GLib default losslessly, including bigint, binary arrays and infinity", () => {
  for (const key of raw.schemas[0].keys) {
    const value = protocol.decodeValue(key.type, Buffer.from(key.default.bytes, "base64"));
    expect(keys[key.name]!.default).toEqual(value);
    expect(Buffer.from(protocol.encodeValue(key.type, keys[key.name]!.default)).toString("base64")).toEqual(
      key.default.bytes,
    );
  }
  expect(keys["signed"]!.default).toEqual({ _tag: "x", value: -9223372036854775808n });
  expect(keys["unsigned"]!.default).toEqual({ _tag: "t", value: 18446744073709551615n });
  expect(Object.is((keys["negative-zero"]!.default as { value: number }).value, -0)).toBe(true);
  expect(keys["infinity"]!.default).toEqual({ _tag: "d", value: Infinity });
});
test("preserves summaries, ranges, choices and enums", () => {
  expect(keys["text"]).toMatchObject({ summary: "Keyboard name", description: "A Unicode keyboard name." });
  expect(keys["count"]!.range).toEqual({ min: { _tag: "i", value: -2 }, max: { _tag: "i", value: 12 } });
  expect(keys["choice"]!.choices).toEqual(["two", "three"]);
  expect(keys["mode"]!.choices).toEqual(["first", "second"]);
});
test("lists a relocatable schema at each path it is given", () => {
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [
        paths.helper,
        paths.schemas,
        "org.test.Metadata",
        "org.test.Relocatable",
        "org.test.Relocatable=/org/test/first/",
        "org.test.Relocatable=/org/test/second/",
      ],
      { encoding: "utf8" },
    ),
  );
  expect(output.schemas.map((schema: { id: string; paths: string[] }) => [schema.id, schema.paths])).toEqual([
    ["org.test.Metadata", ["/org/test/metadata/"]],
    ["org.test.Relocatable", ["/org/test/first/", "/org/test/second/"]],
  ]);
});
test.each([
  [["org.test.Relocatable"], "org.test.Relocatable", "needs its paths"],
  [["org.test.Missing"], "org.test.Missing", "schema missing"],
  [["org.test.Metadata", "org.test.Metadata=/org/test/elsewhere/"], "org.test.Metadata", "fixed path"],
  [["org.test.Relocatable=/org/test/first/"], "org.test.Relocatable", "isn't listed"],
])("refuses %j before producing metadata", (args, id, reason) => {
  const result = spawnSync(process.execPath, [paths.helper, paths.schemas, ...args], { encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(id);
  expect(result.stderr).toContain(reason);
});
test.each([
  ["an attribute set", "settingsFromAttrs"],
  ["a JSON file", "settingsFromFile"],
] as const)("mkSettingsMetadata takes settingsPaths as %s", (_name, field) => {
  const settings = protocol.decodeSettingsMetadata(JSON.parse(readFileSync(paths[field], "utf8")));
  expect(settings.schemas.map((schema) => [schema.id, schema.paths])).toEqual([
    ["org.test.Metadata", ["/org/test/metadata/"]],
    ["org.test.Relocatable", ["/org/test/first/", "/org/test/second/"]],
  ]);
});
test("ships Hangul and panel metadata and an accurate manifest asset", () => {
  const settings = protocol.decodeSettingsMetadata(JSON.parse(readFileSync(`${paths.hangul}/settings.json`, "utf8")));
  const hangul = settings.schemas.find((schema) => schema.id === "org.freedesktop.ibus.engine.hangul")!;
  expect(hangul.paths).toEqual(["/org/freedesktop/ibus/engine/hangul/"]);
  expect(hangul.keys.map((key) => key.name)).toEqual(
    expect.arrayContaining(["hangul-keyboard", "hanja-keys", "initial-input-mode", "auto-reorder", "preedit-mode"]),
  );
  expect(hangul.keys.find((key) => key.name === "hangul-keyboard")).toMatchObject({
    type: "s",
    default: { _tag: "s", value: "2" },
  });
  expect(hangul.keys.find((key) => key.name === "hangul-keyboard")!.choices).toBeUndefined();
  const panel = settings.schemas.find((schema) => schema.id === "org.freedesktop.ibus.panel")!;
  expect(panel.keys.find((key) => key.name === "lookup-table-orientation")).toMatchObject({
    type: "i",
    default: { _tag: "i", value: 1 },
  });
  expect(JSON.parse(readFileSync(`${paths.hangul}/manifest.json`, "utf8")).settingsMetadata).toEqual({
    url: "./settings.json",
    size: readFileSync(`${paths.hangul}/settings.json`).length,
  });
});
