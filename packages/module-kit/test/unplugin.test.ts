// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the bundler plugins hand their bundler: a module's files placed under
// the output directory they are given, or the line to fail the build with.

import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { ManifestRefused } from "../src/build/index.ts";
import {
  moduleOutput,
  outputInWorker,
  refusalMessage,
  runModuleOutput,
  type ModuleOutput,
} from "../src/unplugin/files.ts";

const fixture = new URL("fixtures/build/", import.meta.url);
const script = readFileSync(new URL("module.js", fixture));
const expected = (name: string) => readFileSync(new URL(`expected/${name}`, fixture));

const placed = async (outDir: string | undefined): Promise<readonly string[]> =>
  (await Effect.runPromise(moduleOutput({ script, outDir }))).files.map(({ fileName }) => fileName);

test("places the files under ibus-module/<module name> by default, as buildModuleFiles makes them", async () => {
  const { built, files } = await Effect.runPromise(moduleOutput({ script, outDir: undefined }));

  expect(files.map(({ fileName }) => fileName)).toEqual(
    built.files.map(({ name }) => `ibus-module/build-fixture/${name}`),
  );
  expect(files.map(({ bytes }) => Buffer.from(bytes))).toEqual(built.files.map(({ bytes }) => Buffer.from(bytes)));
  expect(Buffer.from(files.at(-1)!.bytes)).toEqual(expected("manifest.json"));
});

test("places the files under the outDir given, written either way", async () => {
  for (const outDir of ["modules/fixture", "./modules/fixture/", "modules//fixture", "modules\\fixture"]) {
    expect(await placed(outDir)).toEqual([
      expect.stringMatching(/^modules\/fixture\/module\.[0-9a-f]{16}\.js$/),
      "modules/fixture/settings.json",
      "modules/fixture/manifest.json",
    ]);
  }
});

test("refuses an outDir that isn't a directory inside the output", async () => {
  for (const outDir of ["", ".", "./", "..", "../modules", "modules/../..", "/srv/modules", "C:/modules"]) {
    const error = await Effect.runPromise(Effect.flip(moduleOutput({ script, outDir })));
    expect(error).toMatchObject({ _tag: "OutDirRefused", outDir });
  }
});

test("moves the script's source map with it, its sources leading to the same files", async () => {
  const map = JSON.stringify({ version: 3, sources: ["../src/module.ts", "webpack://app/x.ts"], mappings: "" });
  const { files } = await Effect.runPromise(
    moduleOutput({
      script: `${script}//# sourceMappingURL=module.js.map\n`,
      sourceMap: map,
      from: "js",
      outDir: "a/b",
    }),
  );

  const [served, written] = files;
  expect(written!.fileName).toBe(`${served!.fileName}.map`);
  expect(JSON.parse(Buffer.from(written!.bytes).toString())).toMatchObject({
    file: served!.fileName.slice("a/b/".length),
    sources: ["../../src/module.ts", "webpack://app/x.ts"],
  });
});

test("gives a refusal as one line, its tag first", async () => {
  expect(
    await runModuleOutput({ script: 'import "./elsewhere.js";\nexport default {};\n', outDir: undefined }),
  ).toEqual({
    error: 'ScriptHasImports: the script imports "./elsewhere.js" (line 1), but a module script must be one file',
  });

  expect(refusalMessage(new ManifestRefused({ reason: "\n  name\n    is empty" }))).toBe(
    "ManifestRefused: the manifest is refused: name is empty",
  );
});

test("gives the files when the build succeeds", async () => {
  const result = await runModuleOutput({ script, outDir: "out" });
  expect("files" in result && result.files.map(({ fileName }) => fileName).at(-1)).toBe("out/manifest.json");
});

test("gives the same files and refusals from a thread of its own", async () => {
  // Bytes come back from the thread as a plain Uint8Array.
  const compared = (output: ModuleOutput) =>
    "error" in output ? output : output.files.map(({ fileName, bytes }) => ({ fileName, bytes: Buffer.from(bytes) }));

  expect(compared(await outputInWorker({ script, outDir: "out" }))).toEqual(
    compared(await runModuleOutput({ script, outDir: "out" })),
  );
  expect(await outputInWorker({ script: "export default {};\n", outDir: undefined })).toEqual(
    await runModuleOutput({ script: "export default {};\n", outDir: undefined }),
  );
});
