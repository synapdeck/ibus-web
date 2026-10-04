// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  decodeRecord,
  decodeValue,
  encodeValue,
  OutputRecord,
  parseType,
  recordKinds,
  signatureOf,
  type GVariantType,
  type GVariantValue,
} from "../../src/index.ts";
import { fromTree, toTree } from "../../src/ibus/walk.ts";
import { encodedObject, fuzzCounts, objects, objectSchemas, project, requests } from "./corpus.ts";

// The parity check provides the corpus and what the C side made of it; without them these tests
// must fail rather than skip, so a check that lost its manifest can't pass.
const manifest = process.env.IBUS_WEB_PROTOCOL_PARITY;
if (manifest === undefined) throw new Error("IBUS_WEB_PROTOCOL_PARITY must name the parity manifest");
interface ObjectFixture {
  type: keyof typeof objectSchemas;
  normal: boolean;
  value: unknown;
}
interface Observation {
  kind: string;
  args: unknown;
}
interface RequestFixture {
  result: number;
  calls: Observation[];
  value?: string;
  created?: boolean;
  destroyed?: boolean;
}
function json<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("real IBus parity", () => {
  const paths: { corpus: string; output: string } = json(manifest);
  for (const { name, type, value } of objects) {
    it(`C reads TypeScript ${name}`, () => {
      const observed = json<ObjectFixture>(join(paths.output, "ts-objects", `${name}.json`));
      expect(observed.normal).toBe(true);
      expect(observed.value).toEqual(project(encodedObject(type, value)));
      expect(readFileSync(join(paths.output, "ts-objects", `${name}.bin`))).toEqual(
        readFileSync(join(paths.corpus, "objects", `${name}.bin`)),
      );
    });
  }
  it("TypeScript reads every C object and preserves its bytes", () => {
    const files = readdirSync(join(paths.output, "c-objects"))
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(files).toEqual([
      "ascii.json",
      "astral.json",
      "attribute.json",
      "decorated.json",
      "empty-attrs.json",
      "empty-properties.json",
      "empty-text.json",
      "hangul.json",
      "lookup.json",
      "properties.json",
      "property.json",
    ]);
    for (const file of files) {
      const fixture = json<ObjectFixture>(join(paths.output, "c-objects", file));
      const schema = objectSchemas[fixture.type];
      const bytes = readFileSync(join(paths.output, "c-objects", file.replace(/\.json$/, ".bin")));
      const encoded = fromTree(schema)(decodeValue(signatureOf(schema), bytes));
      const value = Schema.decodeUnknownSync(schema)(encoded);
      expect(project(value), file).toEqual(fixture.value);
      expect(
        Buffer.from(encodeValue(signatureOf(schema), toTree(schema)(Schema.encodeUnknownSync(schema)(value)))),
        file,
      ).toEqual(bytes);
    }
  });
  it("dispatches every request with the encoded arguments and expected result", () => {
    const observed = json<Record<string, RequestFixture>>(join(paths.output, "requests.json"));
    expect(Object.keys(observed)).toEqual(["init", "create", ...requests.map((request) => request.name), "destroy"]);
    expect(observed.init!.result).toBe(0);
    expect(observed.init!.value).toBe("initial");
    expect(observed.create!.result).toBe(0);
    expect(observed.create!.created).toBe(true);
    expect(observed.destroy!.result).toBe(0);
    expect(observed.destroy!.destroyed).toBe(true);
    for (const { name, value, result } of requests) {
      expect(observed[name]!.result, name).toBe(result);
      expect(observed[name]!.calls, name).toEqual([{ kind: value._tag, args: project(value) }]);
    }
  });
  it("decodes every emitted record in sequence", () => {
    const expected = json<Observation[]>(join(paths.output, "records.json"));
    const bytes = readFileSync(join(paths.output, "records.bin"));
    const actual: unknown[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      const decoded = decodeRecord(bytes, offset);
      expect(decoded.seq).toBe(actual.length + 1);
      expect(decoded.ic).toBe(decoded.record._tag === "Log" || decoded.record._tag === "SettingWritten" ? 0 : 1);
      expect(decoded.flags).toBe(0);
      actual.push({ kind: decoded.record._tag, args: project(Schema.encodeSync(OutputRecord)(decoded.record)) });
      offset += decoded.size;
    }
    expect(offset).toBe(bytes.length);
    expect(actual).toEqual(expected);
    expect(expected.map((record) => record.kind).sort()).toEqual(
      [...recordKinds.keys()].filter((name) => name !== "Crashed").sort(),
    );
  });
  it("accepts exactly the byte strings GLib calls normal form", () => {
    const cases: { name: string; signature: string; source: keyof typeof fuzzCounts }[] = json(
      join(paths.corpus, "fuzz.json"),
    );
    const observed = json<Record<string, { normal: boolean }>>(join(paths.output, "fuzz.json"));
    expect(Object.keys(observed)).toHaveLength(cases.length);
    const widths = new Set<number>();
    let normal = 0;
    for (const { name, signature } of cases) {
      const bytes = readFileSync(join(paths.corpus, "fuzz", `${name}.bin`));
      let value: GVariantValue | undefined;
      try {
        value = decodeValue(signature, bytes);
      } catch {
        value = undefined;
      }
      expect(value !== undefined, `${name}: ${signature}`).toBe(observed[name]!.normal);
      if (value === undefined) continue;
      normal++;
      const width = offsetWidth(parseType(signature), value, bytes.length);
      if (width !== undefined) widths.add(width);
    }
    // Floors well under the seeded corpus's mix (1000 cases, 555 normal, offsets of every width
    // up to 4), so a corpus that degrades into all-garbage or all-valid input fails here.
    expect(cases).toHaveLength(fuzzCounts.mutated + fuzzCounts.valid + fuzzCounts.large);
    expect(new Set(cases.map((value) => value.signature)).size).toBeGreaterThanOrEqual(100);
    expect(normal / cases.length).toBeGreaterThanOrEqual(0.4);
    expect((cases.length - normal) / cases.length).toBeGreaterThanOrEqual(0.3);
    expect([...widths].sort()).toEqual([1, 2, 4]);
  });
});

// The width of the framing offsets of the outermost container that has any, looking through a
// variant to its child; undefined when the value has no framing offsets there.
function offsetWidth(type: GVariantType, value: GVariantValue, size: number): number | undefined {
  if (value._tag === "v") return offsetWidth(parseType(value.type), value.value, size - 1 - value.type.length);
  const framed =
    type._tag === "a"
      ? type.element.fixedSize === undefined && size > 0
      : type._tag === "()"
        ? type.members.slice(0, -1).some((member) => member.fixedSize === undefined)
        : type._tag === "{}" && type.key.fixedSize === undefined;
  if (!framed || size === 0) return undefined;
  return size > 0xffff ? 4 : size > 0xff ? 2 : 1;
}
