// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The JavaScript library checker, run as the builds run it, over small
// libraries and over Emscripten's own tree or a copy with one of its rules
// changed, which the checker must follow rather than assume.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { nodeTestData as data } from "@ibus-web/test-programs/node-tests";
import { afterAll, describe, expect, test } from "vitest";

const scratch = mkdtempSync(join(tmpdir(), "library-deps-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let files = 0;
const fresh = (name: string): string => join(scratch, `${files++}-${name}`);

// A library file holding source.
const library = (source: string): string => {
  const file = fresh("library.js");
  writeFileSync(file, source);
  return file;
};

const emscripten = data("emscripten");

interface Edit {
  file: string;
  from: string;
  to: string;
}

// A copy of Emscripten's tree with each edit made once to its file under
// src/; the rest of the tree is links to the original.
const editedEmscripten = (...edits: Edit[]): string => {
  const root = fresh("emscripten");
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  for (const name of readdirSync(emscripten)) {
    if (name !== "src") symlinkSync(join(emscripten, name), join(root, name));
  }
  for (const name of readdirSync(join(emscripten, "src"))) {
    const original = join(emscripten, "src", name);
    const own = edits.filter((edit) => edit.file === name);
    if (own.length === 0) {
      symlinkSync(original, join(src, name));
      continue;
    }
    let text = readFileSync(original, "utf8");
    for (const { from, to } of own) {
      // An Emscripten that no longer has the text must fail here, not leave
      // the copy as it was.
      expect(text.split(from), `${name} holds ${JSON.stringify(from)} once`).toHaveLength(2);
      text = text.replace(from, to);
    }
    writeFileSync(join(src, name), text);
  }
  return root;
};

const run = (...args: string[]): { status: number | null; stderr: string } => {
  const { status, stderr } = spawnSync(process.execPath, [data("libraryDeps"), ...args], { encoding: "utf8" });
  return { status, stderr };
};

const check = (file: string, root = emscripten) => run("check", file, root);

// The files emit writes, by name.
const emit = (file: string, root = emscripten): Record<string, string> => {
  const directory = fresh("types");
  const result = run("emit", file, root, directory);
  expect(result).toEqual({ status: 0, stderr: "" });
  return Object.fromEntries(readdirSync(directory).map((name) => [name, readFileSync(join(directory, name), "utf8")]));
};

const addImplicitDeps = "function addImplicitDeps(snippet, deps) {\n";
// The branch that takes a string for a function's source, and the test it
// makes.
const stringBranch = "      } else if (typeof snippet == 'string' && (snippet.match(";

describe("check", () => {
  test("accepts entries that list what they use in __deps", () => {
    expect(check(library('addToLibrary({ $foo: () => 1, bar: () => foo(), bar__deps: ["$foo"] });'))).toEqual({
      status: 0,
      stderr: "",
    });
  });

  test("rejects a use of a library symbol its __deps leave out", () => {
    const { status, stderr } = check(library("addToLibrary({ $foo: () => 1, bar: () => foo() });"));
    expect(status).toBe(1);
    expect(stderr).toContain('bar: uses foo without "$foo" in bar__deps');
  });

  // Emscripten emits a function under its key whatever its own name, so one
  // written inline under the key, `$` and all, is as good as one named
  // after the symbol.
  test("accepts a function named after its key", () => {
    expect(check(library("addToLibrary({ $foo: () => 1 });"))).toEqual({ status: 0, stderr: "" });
  });

  test("rejects a function named otherwise", () => {
    const { status, stderr } = check(library("addToLibrary({ $foo: function other() { return 1; } });"));
    expect(status).toBe(1);
    expect(stderr).toContain("$foo: its value is other, not foo or $foo");
  });

  test("rejects a use of a top-level declaration that isn't a library symbol", () => {
    const { status, stderr } = check(library("const helper = 1;\naddToLibrary({ bar: () => helper });"));
    expect(status).toBe(1);
    expect(stderr).toContain("bar: uses helper, which is declared at the top level but isn't a library symbol");
  });

  test("rejects a library that needs Emscripten's preprocessor", () => {
    const { status, stderr } = check(library("#if ASSERTIONS\naddToLibrary({});\n#endif"));
    expect(status).toBe(1);
    expect(stderr).toContain("uses Emscripten's preprocessor: #if ASSERTIONS");
  });

  test("names the entry when Emscripten's implicit dependencies read a setting it isn't given", () => {
    const root = editedEmscripten({
      file: "jsifier.mjs",
      from: addImplicitDeps,
      to: `${addImplicitDeps}  if (snippet.includes('eval(') && UNKNOWN_SETTING) deps.push('$x');\n`,
    });
    const { status, stderr } = check(
      library('addToLibrary({ $evaluator: function evaluator() { return eval("1"); } });'),
      root,
    );
    expect(status).toBe(1);
    expect(stderr).toContain(
      `$evaluator: ${root}/src/jsifier.mjs: addImplicitDeps needs more than it is given: UNKNOWN_SETTING is not defined`,
    );
  });

  test("lets any other failure of Emscripten's implicit dependencies through", () => {
    const root = editedEmscripten({
      file: "jsifier.mjs",
      from: addImplicitDeps,
      to: `${addImplicitDeps}  if (snippet.includes('eval(')) null.boom;\n`,
    });
    const { status, stderr } = check(
      library('addToLibrary({ $evaluator: function evaluator() { return eval("1"); } });'),
      root,
    );
    expect(status).not.toBe(0);
    expect(stderr).toContain("TypeError: Cannot read properties of null (reading 'boom')");
    expect(stderr).not.toContain("needs more than it is given");
  });

  test("fails unless Emscripten has one test for a function's source in a string", () => {
    const root = editedEmscripten({
      file: "jsifier.mjs",
      from: stringBranch,
      to: `      } else if (typeof snippet == 'string' && snippet.startsWith('async function')) {\n        isFunction = true;\n${stringBranch}`,
    });
    const { status, stderr } = check(library("addToLibrary({});"), root);
    expect(status).toBe(1);
    expect(stderr).toContain("expected one test for a function's source in a string, found 2");
  });
});

describe("emit", () => {
  // A string Emscripten takes for a function's source, whose code it scans
  // for the heap views it uses.
  const heapUser = 'addToLibrary({ $noopUser: "function noopUser() { return HEAPU8[0]; }" });';

  test("lists the Emscripten symbols a function's source in a string uses", () => {
    const types = emit(library(heapUser));
    expect(types["exported-runtime-methods.txt"]).toBe("HEAPU8\n");
  });

  // Emscripten's own test, evaluated, decides, not a pattern copied from it.
  test("takes a string for a function's source only where Emscripten does", () => {
    const root = editedEmscripten({
      file: "jsifier.mjs",
      from: stringBranch,
      to: "      } else if (typeof snippet == 'string' && !snippet.includes('noop') && (snippet.match(",
    });
    const types = emit(library(heapUser), root);
    expect(types["exported-runtime-methods.txt"]).toBe("\n");
  });

  test("writes the decorators Emscripten accepts", async () => {
    const { decoratorSuffixes } = (await import(
      /* @vite-ignore */ pathToFileURL(join(emscripten, "src", "utility.mjs")).href
    )) as { decoratorSuffixes: string[] };
    expect(decoratorSuffixes).toContain("__sig");
    const union = decoratorSuffixes.map((suffix) => JSON.stringify(suffix.slice(2))).join(" | ");
    expect(emit(library("addToLibrary({});"))["decorators.d.ts"]).toContain(
      `export type EmscriptenDecorator = ${union};\n`,
    );
  });

  test("fails on a decorator suffix without its __", () => {
    const root = editedEmscripten({ file: "utility.mjs", from: "  '__sig',\n", to: "  '__sig',\n  'bogus',\n" });
    const { status, stderr } = run("emit", library("addToLibrary({});"), root, fresh("types"));
    expect(status).toBe(1);
    expect(stderr).toContain("decorator suffix bogus doesn't start with __");
  });
});
