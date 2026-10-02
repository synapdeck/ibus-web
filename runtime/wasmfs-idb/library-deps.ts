// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Reads an Emscripten JavaScript library as Emscripten does, by evaluating it
// with an `addToLibrary` that keeps what it is given, and with the decorator
// list and implicit-dependency rule of the Emscripten tree it is given.
//
//   check <library.js> <emscripten root>
//     Fails if an entry names another library symbol that its __deps leave
//     out, or names a top-level declaration of the file that isn't a library
//     symbol, or if a function or class is registered under a key other than
//     its own name. Emscripten emits only the symbols some entry depends on,
//     under their keys, so each of these links cleanly and fails at run time,
//     the first only in programs that pull in nothing else that depends on
//     the symbol.
//
//   emit <library.js> <emscripten root> <directory>
//     Writes what the library depends on from outside itself:
//     exported-runtime-methods.txt (the Emscripten library symbols),
//     exported-functions.txt (the Wasm exports, as C names with their leading
//     underscore) and globals.d.ts, which declares each of them as the bare
//     global the library's code sees, typed from the declarations
//     `--emit-tsd` writes beside it as emscripten.d.ts; and decorators.d.ts,
//     the decorators Emscripten accepts, for the library's type to be
//     checked against.
//
// An Emscripten symbol that no entry depends on is in neither list, so the
// type check of the library, which sees only the listed ones, reports it as
// an unknown name.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

import * as acorn from "acorn";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

// Calls visit on every node of an acorn tree.
const walk = (node: unknown, visit: (node: acorn.AnyNode) => void): void => {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key !== "type") walk(child, visit);
  }
};

const isNode = (value: unknown): value is acorn.AnyNode =>
  value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";

// A library: its entries by key, as addToLibrary was given them.
type Library = Record<string, unknown>;

interface Emscripten {
  decoratorSuffixes: string[];
  isDecorator: (key: string) => boolean;
  isFunctionSource: (string: string) => boolean;
  addImplicitDeps: (key: string, code: string, deps: string[]) => void;
}

// What Emscripten decides about a library's entries, taken from its sources:
// which keys are decorators, which strings it treats as a function's source,
// and the dependencies it adds for what a function's code mentions.
const loadEmscripten = async (root: string): Promise<Emscripten> => {
  const src = path.join(root, "src");
  const { decoratorSuffixes } = (await import(pathToFileURL(path.join(src, "utility.mjs")).href)) as {
    decoratorSuffixes: string[];
  };

  const jsifierFile = path.join(src, "jsifier.mjs");
  const jsifier = fs.readFileSync(jsifierFile, "utf8");
  const tree = acorn.parse(jsifier, {
    ecmaVersion: "latest",
    sourceType: "module",
  });

  // A private function of jsifier.mjs, so it is lifted out by its source and
  // evaluated on its own, with the only settings it reads. The runtime's
  // links set neither, so they get the defaults: WASM_BIGINT on, which only
  // -sWASM=0 turns off, and MEMORY64 off, for wasm32.
  const declaration = tree.body.find(
    (node): node is acorn.FunctionDeclaration =>
      node.type === "FunctionDeclaration" && node.id.name === "addImplicitDeps",
  );
  if (!declaration) return fail(`${jsifierFile}: no addImplicitDeps`);
  const settings: { WASM_BIGINT?: unknown; MEMORY64?: unknown } = {};
  vm.runInNewContext(fs.readFileSync(path.join(src, "settings.js"), "utf8"), settings);
  const context = vm.createContext({
    WASM_BIGINT: settings.WASM_BIGINT,
    MEMORY64: settings.MEMORY64,
  });
  const implicitDeps = vm.runInContext(`(${jsifier.slice(declaration.start, declaration.end)})`, context) as (
    code: string,
    deps: string[],
  ) => void;
  // A name the function reads that the context lacks throws the context's
  // own ReferenceError, not this realm's.
  const ContextReferenceError = vm.runInContext("ReferenceError", context) as ReferenceErrorConstructor;
  const addImplicitDeps = (key: string, code: string, deps: string[]) => {
    try {
      implicitDeps(code, deps);
    } catch (e) {
      if (!(e instanceof ContextReferenceError)) throw e;
      fail(`${key}: ${jsifierFile}: addImplicitDeps needs more than it is given: ${e.message}`);
    }
  };

  // The test of the one branch that sets `isFunction` from what `snippet`, a
  // string, holds. The test is evaluated as written, with `snippet` bound.
  const tests: vm.Script[] = [];
  walk(tree, (node) => {
    if (node.type !== "IfStatement" || node.consequent.type !== "BlockStatement") return;
    const setsIsFunction = node.consequent.body.some(
      (statement) =>
        statement.type === "ExpressionStatement" &&
        statement.expression.type === "AssignmentExpression" &&
        statement.expression.left.type === "Identifier" &&
        statement.expression.left.name === "isFunction",
    );
    if (!setsIsFunction) return;
    let readsSnippet = false;
    walk(node.test, (child) => {
      if (child.type === "Identifier" && child.name === "snippet") readsSnippet = true;
    });
    if (readsSnippet) tests.push(new vm.Script(jsifier.slice(node.test.start, node.test.end)));
  });
  if (tests.length !== 1) {
    fail(`${jsifierFile}: expected one test for a function's source in a string, found ${tests.length}`);
  }
  const [isFunctionTest] = tests;

  return {
    decoratorSuffixes,
    isDecorator: (key) => decoratorSuffixes.some((s) => key.endsWith(s)),
    isFunctionSource: (string) => Boolean(isFunctionTest.runInNewContext({ snippet: string })),
    addImplicitDeps,
  };
};

const load = (file: string) => {
  const source = fs.readFileSync(file, "utf8");
  // Emscripten preprocesses a library before evaluating it, taking every
  // line that starts with # as a directive. This script and tsc read the
  // file as written, which is the same file only when there is nothing to
  // preprocess.
  const directive = source.match(/^[ \t]*#.*$|\{\{\{/m);
  if (directive) {
    fail(`${file}: uses Emscripten's preprocessor: ${directive[0]}`);
  }
  const library: Library = {};
  vm.runInNewContext(
    source,
    { addToLibrary: (entries: Library) => Object.assign(library, entries) },
    { filename: file },
  );
  return { source, library };
};

// Each symbol's code, parsed, and its dependencies: its __deps, and for a
// function, a class or a string Emscripten treats as a function's source,
// those Emscripten infers from the code. A symbol's value is one of those
// or a string holding one expression, the only kinds this script reads.
const entries = (library: Library, emscripten: Emscripten) =>
  Object.keys(library)
    .filter((key) => !emscripten.isDecorator(key))
    .map((key) => {
      const value = library[key];
      let code: string;
      let isFunction: boolean;
      if (typeof value === "function") {
        // Emscripten emits the value's code under the key's name, whatever
        // its own. A function written inline under the key is named after
        // the key, `$` and all, which is as good.
        const own = key.startsWith("$") ? key.slice(1) : key;
        if (value.name !== own && value.name !== key) {
          fail(`${key}: its value is ${value.name || "anonymous"}, not ${own} or ${key}`);
        }
        code = value.toString();
        isFunction = true;
      } else if (typeof value === "string") {
        if (value.startsWith(";")) {
          fail(`${key}: a string of statements isn't supported`);
        }
        code = value.startsWith("=") ? value.slice(1) : value;
        isFunction = emscripten.isFunctionSource(value);
      } else {
        return fail(`${key}: unsupported library value of type ${typeof value}`);
      }

      let tree: acorn.Expression;
      try {
        tree = acorn.parseExpressionAt(code, 0, {
          ecmaVersion: "latest",
        });
      } catch (e) {
        return fail(`${key}: can't parse its code: ${(e as Error).message}`);
      }
      if (code.slice(tree.end).trim() !== "") {
        fail(`${key}: its code is more than one expression`);
      }
      if (tree.type === "Identifier") {
        fail(`${key}: a string naming a symbol is an alias, which isn't supported`);
      }

      const declared = ((library[`${key}__deps`] ?? []) as unknown[]).filter(
        (dep): dep is string => typeof dep === "string",
      );
      if (isFunction) emscripten.addImplicitDeps(key, code, declared);
      return { key, tree, deps: new Set(declared) };
    });

// What the library takes from outside itself.
const external = (library: Library, emscripten: Emscripten) => {
  const runtimeMethods = new Set<string>();
  const functions = new Set<string>();
  for (const { deps } of entries(library, emscripten)) {
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
const references = (node: unknown, found: string[] = []): string[] => {
  if (Array.isArray(node)) {
    for (const child of node) references(child, found);
    return found;
  }
  if (!isNode(node)) return found;
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
    if (key !== "type" && key !== "start" && key !== "end") references(child, found);
  }
  return found;
};

// The names a pattern binds.
const bound = (pattern: acorn.Pattern | null, names: Set<string>): void => {
  switch (pattern?.type) {
    case "Identifier":
      names.add(pattern.name);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        bound(property.type === "RestElement" ? property.argument : property.value, names);
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) bound(element, names);
      break;
    case "RestElement":
      bound(pattern.argument, names);
      break;
    case "AssignmentPattern":
      bound(pattern.left, names);
      break;
  }
};

// The names the file declares at its top level, which the linked program
// has only for those that are library symbols.
const topLevel = (source: string) => {
  const names = new Set<string>();
  const tree = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
  });
  for (const statement of tree.body) {
    if (statement.type === "VariableDeclaration") {
      for (const { id } of statement.declarations) bound(id, names);
    } else if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
      names.add(statement.id.name);
    }
  }
  return names;
};

const check = async (file: string, root: string) => {
  const emscripten = await loadEmscripten(root);
  const { source, library } = load(file);
  const all = entries(library, emscripten);
  const declared = topLevel(source);
  const emscriptenSymbols = new Set(
    all.flatMap(({ deps }) => [...deps].filter((dep) => dep.startsWith("$") && !(dep in library))),
  );

  // The dependency a reference to `name` needs, if it names a symbol at all.
  const symbolFor = (name: string) => {
    if (`$${name}` in library || emscriptenSymbols.has(`$${name}`)) return `$${name}`;
    if (name.startsWith("_")) return name.slice(1);
    return undefined;
  };
  // Whether the linked program has `name`, given that it is the name of one
  // of the file's top-level declarations.
  const emitted = (name: string) => `$${name}` in library || (name.startsWith("_") && name.slice(1) in library);

  const missing: string[] = [];
  for (const { key, tree, deps } of all) {
    for (const name of new Set(references(tree))) {
      if (declared.has(name) && !emitted(name)) {
        missing.push(`${key}: uses ${name}, which is declared at the top level but isn't a library symbol`);
        continue;
      }
      const symbol = symbolFor(name);
      if (symbol !== undefined && symbol !== key && !deps.has(symbol)) {
        missing.push(`${key}: uses ${name} without "${symbol}" in ${key}__deps`);
      }
    }
  }
  if (missing.length > 0) fail(missing.join("\n"));
};

const emit = async (file: string, root: string, directory: string) => {
  const emscripten = await loadEmscripten(root);
  const { runtimeMethods, functions } = external(load(file).library, emscripten);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "exported-runtime-methods.txt"), `${runtimeMethods.join(",")}\n`);
  fs.writeFileSync(path.join(directory, "exported-functions.txt"), `${functions.join(",")}\n`);
  const globals = [...runtimeMethods, ...functions].map(
    (name) => `  const ${name}: MainModule[${JSON.stringify(name)}];\n`,
  );
  fs.writeFileSync(
    path.join(directory, "globals.d.ts"),
    `// What ${path.basename(file)} uses from Emscripten, as the globals its code sees.\n` +
      `import type { MainModule } from "./emscripten.js";\n\n` +
      `declare global {\n${globals.join("")}}\n`,
  );
  const decorators = emscripten.decoratorSuffixes.map((suffix) =>
    suffix.startsWith("__")
      ? JSON.stringify(suffix.slice(2))
      : fail(`decorator suffix ${suffix} doesn't start with __`),
  );
  fs.writeFileSync(
    path.join(directory, "decorators.d.ts"),
    "// The decorators Emscripten accepts on a library symbol, by the name after `__`.\n" +
      `export type EmscriptenDecorator = ${decorators.join(" | ")};\n`,
  );
};

const [command, file, root, directory] = process.argv.slice(2);
if (command === "check" && file && root && !directory) {
  await check(file, root);
} else if (command === "emit" && file && root && directory) {
  await emit(file, root, directory);
} else {
  fail(
    "usage: library-deps.ts check <library.js> <emscripten root>\n       library-deps.ts emit <library.js> <emscripten root> <directory>",
  );
}
