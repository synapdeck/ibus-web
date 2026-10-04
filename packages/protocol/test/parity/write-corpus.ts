// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Arbitrary, Effect } from "effect";
import { encodeRequest, encodeValue, signatureOf } from "../../src/index.ts";
import { toTree } from "../../src/ibus/walk.ts";
import { bytesArbitrary, typeArbitrary } from "../support/arbitraries.ts";
import { encodedObject, lifecycle, objects, objectSchemas, requests } from "./corpus.ts";

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
const types = await Effect.runPromise(Arbitrary.sampleEffect(typeArbitrary(3), { seed: 7103, count: 200 }));
const signatures = [...new Set(types.map((type) => type.signature))].slice(0, 20);
if (signatures.length !== 20) throw new Error("Fuzz corpus needs twenty distinct types");
const bytes = await Effect.runPromise(Arbitrary.sampleEffect(bytesArbitrary(64), { seed: 7104, count: 500 }));
const fuzz = bytes.map((value, index) => {
  const name = String(index).padStart(3, "0");
  const signature = signatures[index % signatures.length]!;
  writeFileSync(join(output, "fuzz", `${name}.bin`), value);
  return { name, signature };
});
writeJson("fuzz.json", fuzz);
