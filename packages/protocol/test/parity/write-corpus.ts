// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Arbitrary, Effect } from "effect";
import { encodeRequest, encodeValue, signatureOf } from "../../src/index.ts";
import { toTree } from "../../src/ibus/walk.ts";
import {
  largeTypedValueArbitrary,
  mutatedEncodingArbitrary,
  typedValueArbitrary,
  type TypedValue,
} from "../support/arbitraries.ts";
import { encodedObject, fuzzCounts, lifecycle, objects, objectSchemas, requests } from "./corpus.ts";

const output = process.argv[2]!;
for (const directory of ["objects", "lifecycle", "requests", "fuzz"])
  mkdirSync(join(output, directory), { recursive: true });
function writeJson(name: string, value: unknown): void {
  writeFileSync(join(output, name), JSON.stringify(value, null, 2));
}
const cases = objects.map(({ name, type, value }) => {
  const schema = objectSchemas[type];
  const signature = signatureOf(schema);
  const tree = toTree(schema)(encodedObject(type, value));
  writeFileSync(join(output, "objects", `${name}.bin`), encodeValue(signature, tree));
  return { name, type, signature };
});
for (const [name, request] of Object.entries(lifecycle))
  writeFileSync(join(output, "lifecycle", `${name}.bin`), encodeRequest(name === "init" ? 0 : 1, request));
for (const { name, value } of requests) writeFileSync(join(output, "requests", `${name}.bin`), encodeRequest(1, value));
writeJson("cases.json", { objects: cases, requests: requests.map(({ name }) => name) });
const [mutated, valid, large] = await Effect.runPromise(
  Effect.all([
    Arbitrary.sampleEffect(mutatedEncodingArbitrary, { seed: 7104, count: fuzzCounts.mutated }),
    Arbitrary.sampleEffect(typedValueArbitrary, { seed: 7105, count: fuzzCounts.valid }),
    Arbitrary.sampleEffect(largeTypedValueArbitrary, { seed: 7106, count: fuzzCounts.large }),
  ]),
);
const encoded = ({ signature, value }: TypedValue) => ({ signature, bytes: encodeValue(signature, value) });
const fuzz = [
  ...mutated.map((sample) => ({ ...sample, source: "mutated" })),
  ...valid.map((sample) => ({ ...encoded(sample), source: "valid" })),
  ...large.map((sample) => ({ ...encoded(sample), source: "large" })),
].map(({ signature, bytes, source }, index) => {
  const name = String(index).padStart(4, "0");
  writeFileSync(join(output, "fuzz", `${name}.bin`), bytes);
  return { name, signature, source };
});
writeJson("fuzz.json", fuzz);
