// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Reads an Emscripten JavaScript library as Emscripten does, by evaluating it
// with an `addToLibrary` that keeps what it is given.
//
//   check <library.js> <emscripten root>
//     Fails if an entry names another library symbol that its __deps leave
//     out. Emscripten emits only the symbols some entry depends on, so a
//     missing dependency links cleanly and fails at run time, and only in
//     programs that pull in nothing else that depends on it.
//
//   emit <library.js> <directory>
//     Writes what the library depends on from outside itself:
//     exported-runtime-methods.txt (the Emscripten library symbols),
//     exported-functions.txt (the Wasm exports, as C names with their leading
//     underscore) and globals.d.ts, which declares each of them as the bare
//     global the library's code sees, typed from the declarations
//     `--emit-tsd` writes beside it as emscripten.d.ts.
//
// An Emscripten symbol that no entry depends on is in neither list, so the
// type check of the library, which sees only the listed ones, reports it as
// an unknown name.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

// Emscripten adds these to a function's dependencies itself when its source
// contains them: the helpers when called, the heap views when mentioned at
// all, and every view for eval().
const implicitCalls = [
  "getDynCaller",
  "getWasmTableEntry",
  "runtimeKeepalivePush",
  "runtimeKeepalivePop",
  "UTF8ToString",
  "getValue",
  "setValue",
];
const heapViews = [
  "HEAP8",
  "HEAP16",
  "HEAPU8",
  "HEAPU16",
  "HEAP32",
  "HEAPU32",
  "HEAPF32",
  "HEAPF64",
  "HEAP64",
  "HEAPU64",
];

const decorator =
  /__(?:sig|proxy|asm|deps|postset|docs|nothrow|noleakcheck|internal|user|async|i53abi|export|force)$/;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const load = (file) => {
  const source = fs.readFileSync(file, "utf8");
  // Emscripten preprocesses a library before evaluating it, taking every
  // line that starts with # as a directive. This script and tsc read the
  // file as written, which is the same file only when there is nothing to
  // preprocess.
  const directive = source.match(/^[ \t]*#.*$|\{\{\{/m);
  if (directive) {
    fail(`${file}: uses Emscripten's preprocessor: ${directive[0]}`);
  }
  const library = {};
  vm.runInNewContext(
    source,
    { addToLibrary: (entries) => Object.assign(library, entries) },
    { filename: file },
  );
  return library;
};

// The code Emscripten emits for an entry and scans for implicit
// dependencies; a string that isn't a function is emitted as written and
// never scanned.
const entries = (library) =>
  Object.keys(library)
    .filter((key) => !decorator.test(key))
    .map((key) => {
      const value = library[key];
      const isFunction = typeof value === "function";
      if (!isFunction && typeof value !== "string") {
        fail(`${key}: unsupported library value of type ${typeof value}`);
      }
      const declared = (library[`${key}__deps`] ?? []).filter(
        (dep) => typeof dep === "string",
      );
      const deps = new Set(declared);
      if (isFunction) {
        const source = value.toString();
        for (const name of implicitCalls) {
          if (source.includes(`${name}(`)) deps.add(`$${name}`);
        }
        const views = source.includes("eval(")
          ? heapViews
          : heapViews.filter((view) => source.includes(view));
        for (const view of views) deps.add(`$${view}`);
      }
      return { key, source: String(value), deps };
    });

// What the library takes from outside itself.
const external = (library) => {
  const runtimeMethods = new Set();
  const functions = new Set();
  for (const { deps } of entries(library)) {
    for (const dep of deps) {
      if (dep in library) continue;
      if (dep.startsWith("$")) runtimeMethods.add(dep.slice(1));
      else functions.add(`_${dep}`);
    }
  }
  return {
    runtimeMethods: [...runtimeMethods].sort(),
    functions: [...functions].sort(),
  };
};

// The identifiers in the code but for property names, class names and
// labels. Names the code binds are among them, so a local named like a
// library symbol counts as a use of that symbol.
const references = (node, found = []) => {
  if (Array.isArray(node)) {
    for (const child of node) references(child, found);
    return found;
  }
  if (
    node === null ||
    typeof node !== "object" ||
    typeof node.type !== "string"
  ) {
    return found;
  }
  switch (node.type) {
    case "Identifier":
      found.push(node.name);
      return found;
    case "MemberExpression":
      references(node.object, found);
      if (node.computed) references(node.property, found);
      return found;
    case "Property":
    case "MethodDefinition":
    case "PropertyDefinition":
      if (node.computed) references(node.key, found);
      references(node.value, found);
      return found;
    case "ClassDeclaration":
    case "ClassExpression":
      references(node.superClass, found);
      references(node.body, found);
      return found;
    case "LabeledStatement":
      references(node.body, found);
      return found;
    case "BreakStatement":
    case "ContinueStatement":
    case "MetaProperty":
      return found;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== "type" && key !== "start" && key !== "end")
      references(child, found);
  }
  return found;
};

const check = async (file, emscriptenRoot) => {
  const require = createRequire(path.join(emscriptenRoot, "package.json"));
  const acorn = await import(pathToFileURL(require.resolve("acorn")).href);
  const library = load(file);
  const all = entries(library);
  const emscriptenSymbols = new Set(
    all.flatMap(({ deps }) =>
      [...deps].filter((dep) => dep.startsWith("$") && !(dep in library)),
    ),
  );

  // The dependency a reference to `name` needs, if it names a symbol at all.
  const symbolFor = (name) => {
    if (`$${name}` in library || emscriptenSymbols.has(`$${name}`))
      return `$${name}`;
    if (name.startsWith("_")) return name.slice(1);
    return undefined;
  };

  const missing = [];
  for (const { key, source, deps } of all) {
    const code = source.startsWith("=") ? source.slice(1) : source;
    let tree;
    try {
      tree = acorn.parseExpressionAt(code, 0, { ecmaVersion: "latest" });
    } catch (e) {
      fail(`${key}: can't parse its code: ${e.message}`);
    }
    if (code.slice(tree.end).trim() !== "") {
      fail(`${key}: its code is more than one expression`);
    }
    for (const name of new Set(references(tree))) {
      const symbol = symbolFor(name);
      if (symbol !== undefined && symbol !== key && !deps.has(symbol)) {
        missing.push(
          `${key}: uses ${name} without "${symbol}" in ${key}__deps`,
        );
      }
    }
  }
  if (missing.length > 0) fail(missing.join("\n"));
};

const emit = (file, directory) => {
  const { runtimeMethods, functions } = external(load(file));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "exported-runtime-methods.txt"),
    `${runtimeMethods.join(",")}\n`,
  );
  fs.writeFileSync(
    path.join(directory, "exported-functions.txt"),
    `${functions.join(",")}\n`,
  );
  const globals = [...runtimeMethods, ...functions].map(
    (name) => `  const ${name}: MainModule[${JSON.stringify(name)}];\n`,
  );
  fs.writeFileSync(
    path.join(directory, "globals.d.ts"),
    `// What ${path.basename(file)} uses from Emscripten, as the globals its code sees.\n` +
      `import type { MainModule } from "./emscripten.js";\n\n` +
      `declare global {\n${globals.join("")}}\n`,
  );
};

const [command, file, target] = process.argv.slice(2);
if (command === "check" && file && target) {
  await check(file, target);
} else if (command === "emit" && file && target) {
  emit(file, target);
} else {
  fail(
    "usage: library-deps.mjs check <library.js> <emscripten root>\n       library-deps.mjs emit <library.js> <directory>",
  );
}
