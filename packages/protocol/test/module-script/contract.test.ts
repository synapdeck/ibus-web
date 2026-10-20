// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { IBusAttrType, IBusPropState, IBusPropType } from "../../src/ibus/enums.ts";
import { IBusInputHints, IBusInputPurpose, IBusModifier } from "../../src/ibus/flags.ts";
import { decodeModuleManifest } from "../../src/manifest.ts";
import type { ModuleScript } from "../../src/module-script.ts";
import { specifiers } from "../support/specifiers.ts";

const packageDir = fileURLToPath(new URL("../../", import.meta.url));
const distJs = join(packageDir, "dist/module-script.js");
const distTypes = join(packageDir, "dist/module-script.d.ts");
const fixtureDir = fileURLToPath(new URL("../../../worker-host/test/fixtures/js-module/", import.meta.url));
const fixtureScript = join(fixtureDir, "module.mjs");

describe("the module-script subpath's build", () => {
  test("imports and re-exports nothing", () => {
    for (const file of [distJs, distTypes]) expect(specifiers(readFileSync(file, "utf8"))).toEqual([]);
  });

  test("recognizes every form of import and re-export", () => {
    expect(specifiers(`import { a } from "x";\nexport * from "y";\nimport type { B } from 'z';\nimport "w";`)).toEqual([
      "x",
      "z",
      "w",
      "y",
    ]);
    expect(specifiers(`export { a } from "./chunk.js";\nconst m = import("./lazy.js");`)).toEqual([
      "./chunk.js",
      "./lazy.js",
    ]);
    expect(specifiers(`type T = import("./types.js").T;`)).toEqual(["./types.js"]);
  });

  test("exports the ABI number and IBus's constants, and no other value", async () => {
    expect(Object.keys(await import(distJs)).toSorted()).toEqual(
      [
        "MODULE_ABI",
        "InputHints",
        "InputPurpose",
        "Modifier",
        "PreeditHint",
        "Underline",
        "attributeTypes",
        "logLevels",
        "propertyKinds",
        "propertyStates",
      ].toSorted(),
    );
  });

  test("states IBus's own values", async () => {
    const contract = (await import(distJs)) as typeof import("../../src/module-script.ts");

    // The bits a key's state carries, not the pointer buttons or the masks IBus keeps for itself.
    const keyBits = Object.entries(IBusModifier).filter(
      ([name]) => !/^(?:BUTTON\d|HANDLED|FORWARD|IGNORED|MODIFIER)$/.test(name),
    );
    expect(contract.Modifier).toEqual(Object.fromEntries(keyBits));

    expect(contract.InputPurpose).toEqual(IBusInputPurpose);
    expect(contract.InputHints).toEqual(IBusInputHints);

    // IBusAttrPreedit is not in the protocol: these are libibus's ibusattribute.h.
    expect(contract.PreeditHint).toEqual({
      DEFAULT: 0,
      WHOLE: 1,
      SELECTION: 2,
      PREDICTION: 3,
      PREFIX: 4,
      SUFFIX: 5,
      ERROR_SPELLING: 6,
      ERROR_COMPOSE: 7,
      NONE: 1 << 8,
    });

    const capitalized = (name: string) => `${name[0]!.toUpperCase()}${name.slice(1)}`;
    expect(contract.attributeTypes.map(capitalized)).toEqual(Object.keys(IBusAttrType));
    expect(contract.propertyKinds.map(capitalized)).toEqual(Object.keys(IBusPropType));
    expect(contract.propertyStates.map(capitalized)).toEqual(Object.keys(IBusPropState));
  });

  test("is the package's module-script export", () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    expect(manifest.exports["./module-script"]).toEqual({
      types: "./dist/module-script.d.ts",
      default: "./dist/module-script.js",
    });
  });
});

describe("the fixture module script", () => {
  const manifest = decodeModuleManifest(JSON.parse(readFileSync(join(fixtureDir, "manifest.json"), "utf8")), {
    minimum: 0,
    maximum: 0,
  });

  test("matches its manifest", async () => {
    const script: ModuleScript = (await import(fixtureScript)).default;

    expect(manifest.kind).toBe("js");
    if (manifest.kind !== "js") return;

    expect(manifest.moduleAbi).toBe(script.ibusWebModule);
    expect(manifest.module.size).toBe(statSync(fixtureScript).size);
    expect({ name: manifest.name, version: manifest.version, license: manifest.license }).toEqual({
      name: script.name,
      version: script.version,
      license: script.license,
    });
    expect(manifest.engines).toEqual(
      Object.entries(script.engines).map(([name, engine]) => ({ name, ...engine.descriptor })),
    );
    expect(manifest.settingsSchemas).toEqual(
      Object.entries(script.engines)
        .filter(([, engine]) => engine.settings !== undefined)
        .map(([name]) => `${script.settingsPrefix}.${name}`),
    );
  });
});

// A valid script, each part of which a mistake below replaces.
const validScript = ({
  brand = "1",
  setting = `{ type: "b", default: true }`,
  session = `processKey: (_keyval, _keycode, _state, character) => character === "a"`,
  create = "",
} = {}) => `import type { ModuleScript } from "@ibus-web/protocol/module-script";

export default {
  ibusWebModule: ${brand},
  name: "test",
  version: "1",
  license: "MIT",
  settingsPrefix: "org.example.test",
  engines: {
    test: {
      descriptor: { displayName: "Test", languages: [], keyboard: { layout: "us", passThrough: [] } },
      settings: { key: ${setting} },
      create(context) {
        ${create}
        return { ${session} };
      },
    },
  },
} satisfies ModuleScript;
`;

const mistakes: Record<string, Parameters<typeof validScript>[0]> = {
  "another ABI": { brand: "2" },
  "a default of another type": { setting: `{ type: "b", default: "yes" }` },
  "a range on a string": { setting: `{ type: "s", default: "", range: { min: 0, max: 1 } }` },
  "choices on an integer": { setting: `{ type: "i", default: 0, choices: ["0"] }` },
  "an unknown setting type": { setting: `{ type: "u", default: 0 }` },
  "a key handler that answers with text": { session: `processKey: () => "yes"` },
  "an unknown handler argument": { session: `focusIn: (now: number) => void now` },
  "an unknown preedit mode": { create: `context.preedit("x", 1, true, "keep");` },
  "an unknown property kind": { create: `context.registerProperties([{ key: "k", kind: "check", label: "K" }]);` },
  "a property state as a number": {
    create: `context.updateProperty({ key: "k", kind: "toggle", label: "K", state: 1 });`,
  },
  "an object as a setting value": { create: `context.settings.set("key", {});` },
  "a timer without its cancel": { create: `const cancel: number = context.after(1, () => {});` },
  "an unknown attribute type": {
    create: `context.commit({ text: "x", attributes: [{ type: "bold", value: 1, start: 0, end: 1 }] });`,
  },
};

describe("the contract's types", () => {
  const dir = mkdtempSync(join(tmpdir(), "module-script-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // tsc reports each error on a line that starts with the file's name.
  const typeErrors = (() => {
    writeFileSync(join(dir, "valid.ts"), validScript());
    for (const [index, mistake] of Object.values(mistakes).entries())
      writeFileSync(join(dir, `mistake-${index}.ts`), validScript(mistake));
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "es2023",
          lib: ["es2023"],
          module: "esnext",
          moduleResolution: "bundler",
          types: [],
          strict: true,
          exactOptionalPropertyTypes: true,
          allowJs: true,
          checkJs: true,
          noEmit: true,
          paths: { "@ibus-web/protocol/module-script": [distTypes] },
        },
        include: [join(dir, "*.ts"), fixtureScript],
      }),
    );

    let output = "";
    try {
      const tsc = join(packageDir, "node_modules/typescript/bin/tsc");
      execFileSync(process.execPath, [tsc, "-p", dir, "--pretty", "false"], { encoding: "utf8" });
    } catch (error) {
      output = (error as { stdout: string }).stdout;
    }
    return (file: string): string[] =>
      output.split("\n").filter((line) => line.includes(file) && / error TS/.test(line));
  })();

  test("accept the fixture", () => expect(typeErrors("module.mjs")).toEqual([]));
  test("accept a minimal script", () => expect(typeErrors("valid.ts")).toEqual([]));

  for (const [index, name] of Object.keys(mistakes).entries())
    test(`refuse ${name}`, () => expect(typeErrors(`mistake-${index}.ts`)).toHaveLength(1));
});
