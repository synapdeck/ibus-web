// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The built ibus-web-module bin as a subprocess over the build fixtures: what
// it prints and exits with, and the files it leaves.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";

const bin = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fixture = fileURLToPath(new URL("fixtures/build/module.js", import.meta.url));
const expected = (name: string) => readFileSync(new URL(`fixtures/build/expected/${name}`, import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "ibus-web-module-cli-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let runs = 0;
const next = (name: string) => join(scratch, `${runs++}-${name}`);

const run = (...args: string[]) => {
  const { status, stdout, stderr } = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
  return { status, stdout, stderr };
};

const sound = `{
  ibusWebModule: 1,
  name: "small",
  version: "0.1.0",
  license: "MIT",
  engines: {
    only: { descriptor: { displayName: "Only", languages: [], keyboard: { layout: "us", passThrough: [] } }, create() {} },
  },
}`;

const scriptFile = (source: string) => {
  const path = next("script.js");
  writeFileSync(path, source);
  return path;
};

const manifestVersion = (directory: string): string =>
  (JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as { version: string }).version;

test("a build prints the directory and the version, and writes the expected files", () => {
  const out = next("out");
  const { status, stdout, stderr } = run("build", fixture, "--out", out);

  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  expect(stdout).toBe(`Built ${out}: ${manifestVersion(out)}\n`);
  expect(readFileSync(join(out, "manifest.json"))).toEqual(expected("manifest.json"));
  expect(readFileSync(join(out, "settings.json"))).toEqual(expected("settings.json"));
  expect(readdirSync(out)).toHaveLength(3);
});

test("a map beside the script is written beside the built script, its sources leading to the same files", () => {
  const directory = next("bundle");
  mkdirSync(directory);
  const script = join(directory, "module.js");
  writeFileSync(script, `export default ${sound};\n//# sourceMappingURL=module.js.map\n`);
  writeFileSync(
    join(directory, "module.js.map"),
    JSON.stringify({ version: 3, sources: ["../src/small.ts"], mappings: "" }),
  );

  const out = join(directory, "module");
  expect(run("build", script, "--out", out).status).toBe(0);

  const name = readdirSync(out).find((file) => file.endsWith(".js"))!;
  expect(readFileSync(join(out, name), "utf8")).toMatch(new RegExp(`\\n//# sourceMappingURL=${name}\\.map\\n$`));
  expect(JSON.parse(readFileSync(join(out, `${name}.map`), "utf8"))).toMatchObject({
    file: name,
    sources: ["../../src/small.ts"],
  });
});

test("--out=<dir> and the options before the script are the same build", () => {
  const out = next("out");
  const { status } = run("build", `--out=${out}`, fixture);

  expect(status).toBe(0);
  expect(readFileSync(join(out, "manifest.json"))).toEqual(expected("manifest.json"));
});

test("each refusal is one line on stderr naming the check and the reason, and exits 1", () => {
  const cases: [string, string, string][] = [
    ["ScriptHasImports", `import "polyfill";\nexport default ${sound};\n`, `"polyfill" (line 1)`],
    ["ScriptThrew", `throw new Error("no module here");\nexport default ${sound};\n`, "Error: no module here"],
    ["ModuleRefused", "export default 1;\n", "isn't an ibus-web module"],
    [
      "ModuleRefused",
      `export default { ...${sound}, engines: { only: { create() {} } } };\n`,
      "its engine only has no descriptor",
    ],
    ["ManifestRefused", `export default { ...${sound}, name: "not a directory name" };\n`, "name"],
  ];

  for (const [tag, source, reason] of cases) {
    const script = scriptFile(source);
    const out = next("out");
    const { status, stdout, stderr } = run("build", script, "--out", out);

    expect(status, tag).toBe(1);
    expect(stdout, tag).toBe("");
    expect(stderr.trimEnd().split("\n"), tag).toHaveLength(1);
    expect(stderr, tag).toContain(`${script}: ${tag}: `);
    expect(stderr, tag).toContain(reason);
    expect(existsSync(out), tag).toBe(false);
  }
});

test("a refusal names the engine and key at fault", () => {
  const source = `export default { ...${sound}, settingsPrefix: "org.example", engines: { only: { ...${sound}.engines.only, settings: { flag: { type: "b", default: "yes" } } } } };\n`;
  const { status, stderr } = run("build", scriptFile(source), "--out", next("out"));

  expect(status).toBe(1);
  expect(stderr).toContain("ModuleRefused");
  expect(stderr).toContain(`its engine only's setting flag has the default "yes"`);
});

test("a script that can't be read, or an output that can't be written, exits 1", () => {
  const missing = join(scratch, "missing.js");
  const unreadable = run("build", missing, "--out", next("out"));
  expect(unreadable.status).toBe(1);
  expect(unreadable.stderr).toContain(`${missing} can't be read`);

  const file = scriptFile("");
  const blocked = run("build", fixture, "--out", join(file, "out"));
  expect(blocked.status).toBe(1);
  expect(blocked.stderr).toContain("WriteFailed");
});

test("a version without build metadata gets +js.<hash>, and one with it gets .js.<hash>", () => {
  const plain = next("plain");
  const meta = next("meta");
  expect(run("build", scriptFile(`export default { ...${sound}, version: "1.2.0" };\n`), "--out", plain).status).toBe(
    0,
  );
  expect(
    run("build", scriptFile(`export default { ...${sound}, version: "1.2.0+meta" };\n`), "--out", meta).status,
  ).toBe(0);

  expect(manifestVersion(plain)).toMatch(/^1\.2\.0\+js\.[0-9a-f]{16}$/);
  expect(manifestVersion(meta)).toMatch(/^1\.2\.0\+meta\.js\.[0-9a-f]{16}$/);
});

test("--help prints usage and exits 0", () => {
  const { status, stdout } = run("--help");

  expect(status).toBe(0);
  expect(stdout).toContain("Usage: ibus-web-module build <script> --out <dir>");
});

test("an unknown option, a missing argument or another command prints usage and exits 2", () => {
  const cases: string[][] = [
    ["build", fixture, "--out", next("out"), "--bogus"],
    ["build", fixture],
    ["build", "--out", next("out")],
    ["build", fixture, "--out"],
    ["build", fixture, "extra", "--out", next("out")],
    ["pack", fixture],
    [],
  ];

  for (const args of cases) {
    const { status, stdout, stderr } = run(...args);

    expect(status, args.join(" ")).toBe(2);
    expect(stdout, args.join(" ")).toBe("");
    expect(stderr, args.join(" ")).toContain("Usage: ibus-web-module build <script> --out <dir>");
  }
});
