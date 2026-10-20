// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The post-processor over a module script written against the contract: the
// files it writes, byte for byte, and what it refuses before writing any.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, expect, test } from "vitest";
import { buildModule, buildModuleFiles, type BuildModuleError, type BuiltModule } from "../src/build/index.ts";

const fixture = new URL("fixtures/build/", import.meta.url);
const script = readFileSync(new URL("module.js", fixture));
const expected = (name: string) => readFileSync(new URL(`expected/${name}`, fixture));

const scratch = mkdtempSync(join(tmpdir(), "ibus-web-build-module-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let builds = 0;
const outDir = () => join(scratch, `out-${builds++}`);

const build = (source: Uint8Array | string, into = outDir(), sourceMap?: string): Promise<BuiltModule> =>
  Effect.runPromise(buildModule({ script: source, outDir: into, ...(sourceMap === undefined ? {} : { sourceMap }) }));

const refusal = (source: Uint8Array | string, into = outDir(), sourceMap?: string): Promise<BuildModuleError> =>
  Effect.runPromise(
    Effect.flip(buildModule({ script: source, outDir: into, ...(sourceMap === undefined ? {} : { sourceMap }) })),
  );

const sha256 = (...parts: readonly Uint8Array[]): string => {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part);
  return digest.digest("hex");
};

// What a directory holds, by name.
const contents = (directory: string): Record<string, Buffer> =>
  Object.fromEntries(readdirSync(directory).map((name) => [name, readFileSync(join(directory, name))]));

const sound = `{
  ibusWebModule: 1,
  name: "small",
  version: "0.1.0",
  license: "MIT",
  engines: {
    only: { descriptor: { displayName: "Only", languages: [], keyboard: { layout: "us", passThrough: [] } }, create() {} },
  },
}`;

// The sound module with fields of its own replacing its fields.
const moduleWith = (fields: string) => `export default { ...${sound}, ${fields} };\n`;

test("the fixture builds into its script, settings metadata and manifest, as the expected files hold them", async () => {
  const directory = outDir();
  const built = await build(script, directory);

  const scriptName = `module.${sha256(script).slice(0, 16)}.js`;
  expect(contents(directory)).toEqual({
    [scriptName]: script,
    "settings.json": expected("settings.json"),
    "manifest.json": expected("manifest.json"),
  });

  expect(built.manifest.module).toEqual({ url: `./${scriptName}`, size: script.length });
  expect(built.manifest.version).toBe(`1.2.3+js.${sha256(script, expected("settings.json")).slice(0, 16)}`);
  expect(built.files.map(({ name }) => name)).toEqual([scriptName, "settings.json", "manifest.json"]);
  for (const { name, bytes } of built.files) expect(Buffer.from(bytes), name).toEqual(contents(directory)[name]);
});

test("a second build of the same script is byte-identical, into a new directory or over the first", async () => {
  const first = outDir();
  const second = outDir();
  await build(script, first);
  await build(script, second);
  expect(contents(second)).toEqual(contents(first));

  await build(script, first);
  expect(contents(first)).toEqual(contents(second));
});

test("a script given as text builds as its UTF-8 bytes", async () => {
  const fromBytes = outDir();
  const fromText = outDir();
  await build(script, fromBytes);
  await build(script.toString("utf8"), fromText);
  expect(contents(fromText)).toEqual(contents(fromBytes));
});

test("a module without settings has no settings.json, and its version hashes the script alone", async () => {
  const source = moduleWith("");
  const bytes = Buffer.from(source);
  const directory = outDir();
  const built = await build(source, directory);

  const hash = sha256(bytes).slice(0, 16);
  expect(Object.keys(contents(directory)).toSorted()).toEqual(["manifest.json", `module.${hash}.js`]);
  expect(built.manifest).toEqual({
    kind: "js",
    name: "small",
    version: `0.1.0+js.${hash}`,
    license: "MIT",
    protocol: 1,
    moduleAbi: 1,
    module: { url: `./module.${hash}.js`, size: bytes.length },
    engines: [{ name: "only", displayName: "Only", languages: [], keyboard: { layout: "us", passThrough: [] } }],
    settingsSchemas: [],
  });
});

// A bundler writes the comment on a line of its own after the code.
test("a source map is written beside the script, named for it, and the script's hash covers both", async () => {
  const code = moduleWith("").trimEnd();
  const map = JSON.stringify({ version: 3, file: "bundle.js", sources: ["../src/small.ts"], mappings: "AAAA" });
  const directory = outDir();
  const built = await build(`${code}\n//# sourceMappingURL=bundle.js.map\n`, directory, map);

  const hash = sha256(Buffer.from(code)).slice(0, 16);
  const scriptName = `module.${sha256(Buffer.from(code), Buffer.from(map)).slice(0, 16)}.js`;
  const served = `${code}\n//# sourceMappingURL=${scriptName}.map\n`;
  expect(built.files.map(({ name }) => name)).toEqual([scriptName, `${scriptName}.map`, "manifest.json"]);
  expect(contents(directory)[scriptName]!.toString()).toBe(served);
  expect(JSON.parse(contents(directory)[`${scriptName}.map`]!.toString())).toEqual({
    ...JSON.parse(map),
    file: scriptName,
  });
  expect(built.manifest.module).toEqual({ url: `./${scriptName}`, size: Buffer.byteLength(served) });
  expect(built.manifest.version).toBe(`0.1.0+js.${hash}`);

  // The same code and map with another comment, or none, is the same script.
  for (const source of [`${code}\n//# sourceMappingURL=elsewhere.js.map`, code]) {
    const again = await build(source, outDir(), map);
    expect(again.manifest.module.url).toBe(`./${scriptName}`);
    expect(again.manifest.version).toBe(built.manifest.version);
  }
});

test("a changed map renames the script and its map, and no map leaves the name to the code", async () => {
  const code = moduleWith("").trimEnd();
  const map = JSON.stringify({ version: 3, sources: ["small.ts"], mappings: "AAAA" });
  const changed = JSON.stringify({ version: 3, sources: ["small.ts"], mappings: "AACA" });

  const first = await build(code, outDir(), map);
  const second = await build(code, outDir(), changed);
  expect(second.manifest.module.url).not.toBe(first.manifest.module.url);
  expect(second.files[1]!.name).toBe(`${second.files[0]!.name}.map`);
  expect(second.manifest.version).toBe(first.manifest.version);

  const bare = await build(`${code}\n//# sourceMappingURL=bundle.js.map\n`);
  expect(bare.manifest.module.url).toBe(`./module.${sha256(Buffer.from(code)).slice(0, 16)}.js`);
});

test("a map without a comment is written but not named in the script", async () => {
  const code = moduleWith("").trimEnd();
  const map = JSON.stringify({ version: 3, sources: ["small.ts"], mappings: "AAAA" });
  const built = await Effect.runPromise(buildModuleFiles({ script: code, sourceMap: map, sourceMapComment: false }));

  const scriptName = built.files[0]!.name;
  expect(built.files.map(({ name }) => name)).toEqual([scriptName, `${scriptName}.map`, "manifest.json"]);
  expect(Buffer.from(built.files[0]!.bytes).toString()).toBe(code);
  expect(built.manifest.module.size).toBe(Buffer.byteLength(code));
});

test("a comment naming a map that isn't given is dropped, and an inlined map is written as a file", async () => {
  const code = moduleWith("").trimEnd();
  const map = { version: 3, sources: ["small.ts"], mappings: "AAAA" };
  const scriptName = `module.${sha256(Buffer.from(code)).slice(0, 16)}.js`;
  const mapName = `module.${sha256(Buffer.from(code), Buffer.from(JSON.stringify(map))).slice(0, 16)}.js`;

  const dropped = await build(`${code}\n//# sourceMappingURL=bundle.js.map`);
  expect(dropped.files.map(({ name }) => name)).toEqual([scriptName, "manifest.json"]);
  expect(Buffer.from(dropped.files[0]!.bytes).toString()).toBe(code);

  const inline = `data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
  const inlined = await build(`${code}\n//# sourceMappingURL=${inline}\n`);
  expect(inlined.files.map(({ name }) => name)).toEqual([mapName, `${mapName}.map`, "manifest.json"]);
  expect(JSON.parse(Buffer.from(inlined.files[1]!.bytes).toString())).toEqual({ ...map, file: mapName });
});

test("a source map that isn't a JSON object is refused", async () => {
  for (const sourceMap of ["{", "[]", "3"]) {
    expect(await refusal(moduleWith(""), outDir(), sourceMap)).toMatchObject({ _tag: "SourceMapUnreadable" });
  }
});

test("an engine is named by its key in the manifest, whatever name its descriptor carries", async () => {
  const built = await build(
    moduleWith(
      `engines: { only: { ...${sound}.engines.only, descriptor: { ...${sound}.engines.only.descriptor, name: "other" } } }`,
    ),
  );
  expect(built.manifest.engines.map(({ name }) => name)).toEqual(["only"]);
});

test("import.meta isn't an import", async () => {
  const built = await build(`const here = import.meta.url;\n${moduleWith("")}`);
  expect(built.manifest.name).toBe("small");
});

test("a script with any import is refused with each import's specifier and line", async () => {
  const cases: [string, string, readonly object[]][] = [
    ["a static import", `import { x } from "./x.js";\n${moduleWith("")}`, [{ specifier: "./x.js", line: 1 }]],
    ["an import for its effects", `\nimport "polyfill";\n${moduleWith("")}`, [{ specifier: "polyfill", line: 2 }]],
    ["a re-export", `export * from "other";\n${moduleWith("")}`, [{ specifier: "other", line: 1 }]],
    ["a named re-export", `export { y } from "other";\n${moduleWith("")}`, [{ specifier: "other", line: 1 }]],
    [
      "dynamic imports",
      `const later = () => import("./later.js");\nconst computed = (name) => import(name);\n${moduleWith("")}`,
      [
        { specifier: "./later.js", line: 1 },
        { specifier: undefined, line: 2 },
      ],
    ],
  ];

  for (const [what, source, imports] of cases) {
    const error = await refusal(source);
    expect(error, what).toMatchObject({ _tag: "ScriptHasImports", imports });
  }
});

test("each refusal has its tag, and nothing is written for it", async () => {
  const cases: [string, Uint8Array | string, object][] = [
    ["a script that isn't UTF-8", new Uint8Array([0xff, 0xfe, 0x00]), { _tag: "ScriptUnreadable" }],
    [
      "a script that throws as it is imported",
      `throw new Error("no module here");\n${moduleWith("")}`,
      { _tag: "ScriptThrew", reason: "Error: no module here" },
    ],
    [
      "a default export that isn't a module",
      "export default 1;\n",
      { _tag: "ModuleRefused", reason: expect.stringContaining("isn't an ibus-web module") },
    ],
    [
      "a script without a default export",
      "export const module = 1;\n",
      { _tag: "ModuleRefused", reason: expect.stringContaining("isn't an ibus-web module") },
    ],
    [
      "another module ABI",
      moduleWith("ibusWebModule: 2"),
      { _tag: "ModuleRefused", reason: "it states the module ABI 2, but this build writes 1" },
    ],
    [
      "a persist that isn't a function",
      moduleWith("persist: 1"),
      { _tag: "ModuleRefused", reason: "its persist isn't a function" },
    ],
    [
      "a version that isn't a string",
      moduleWith("version: 1"),
      { _tag: "ModuleRefused", reason: "its version isn't a string" },
    ],
    [
      "an engine without a descriptor",
      moduleWith("engines: { only: { create() {} } }"),
      { _tag: "ModuleRefused", reason: "its engine only has no descriptor" },
    ],
    [
      "an unsound declaration",
      moduleWith(
        `settingsPrefix: "org.example", engines: { only: { ...${sound}.engines.only, settings: { flag: { type: "b", default: "yes" } } } }`,
      ),
      {
        _tag: "ModuleRefused",
        reason: `its engine only's setting flag has the default "yes", which it doesn't accept`,
      },
    ],
    [
      "an engine whose settings schema has no path",
      moduleWith(
        `settingsPrefix: "org.example", engines: { "": { ...${sound}.engines.only, settings: { flag: { type: "b", default: true } } } }`,
      ),
      { _tag: "SettingsMetadataRefused" },
    ],
    [
      "a name the manifest refuses",
      moduleWith(`name: "not a directory name"`),
      { _tag: "ManifestRefused", reason: expect.stringContaining("name") },
    ],
    [
      "a descriptor the manifest refuses",
      moduleWith(
        `engines: { only: { ...${sound}.engines.only, descriptor: { displayName: "", languages: [], keyboard: { layout: "us", passThrough: [] } } } }`,
      ),
      { _tag: "ManifestRefused", reason: expect.stringContaining("displayName") },
    ],
  ];

  for (const [what, source, fields] of cases) {
    const into = outDir();
    const error = await refusal(source, into);
    expect(error, what).toMatchObject(fields);
    expect(existsSync(into), what).toBe(false);
  }
});

test("an output directory that can't be made is refused with its path", async () => {
  const file = join(scratch, "a-file");
  writeFileSync(file, "");

  const into = join(file, "out");
  expect(await refusal(script, into)).toMatchObject({ _tag: "WriteFailed", path: into });
});

test("a version with build metadata gets the hash as a further identifier", async () => {
  const hash = (source: string) => sha256(Buffer.from(source)).slice(0, 16);
  const plain = moduleWith(`version: "1.2.0"`);
  const meta = moduleWith(`version: "1.2.0+meta"`);

  expect((await build(plain)).manifest.version).toBe(`1.2.0+js.${hash(plain)}`);
  expect((await build(meta)).manifest.version).toBe(`1.2.0+meta.js.${hash(meta)}`);
});
