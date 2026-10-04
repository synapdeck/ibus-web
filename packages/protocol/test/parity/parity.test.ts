// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { decodeRecord, decodeValue, encodeValue, OutputRecord, recordKinds, signatureOf } from "../../src/index.ts";
import { fromTree, toTree } from "../../src/ibus/walk.ts";
import { encodedObject, objects, objectSchemas, project, requests } from "./corpus.ts";

const manifest = process.env.IBUS_WEB_PROTOCOL_PARITY;
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

describe.skipIf(!manifest)("real IBus parity", () => {
  const paths: { corpus: string; output: string } = manifest ? json(manifest) : { corpus: "", output: "" };
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
    const files = readdirSync(join(paths.output, "c-objects")).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(11);
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
  it("agrees with GLib normal form on 500 byte strings over twenty types", () => {
    const cases: { name: string; signature: string }[] = json(join(paths.corpus, "fuzz.json"));
    const observed = json<Record<string, { normal: boolean }>>(join(paths.output, "fuzz.json"));
    expect(cases).toHaveLength(500);
    expect(new Set(cases.map((value) => value.signature)).size).toBe(20);
    expect(Object.keys(observed)).toHaveLength(cases.length);
    for (const { name, signature } of cases) {
      let accepted = true;
      try {
        decodeValue(signature, readFileSync(join(paths.corpus, "fuzz", `${name}.bin`)));
      } catch {
        accepted = false;
      }
      expect(accepted, `${name}: ${signature}`).toBe(observed[name]!.normal);
    }
  });
});
