// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { dependencyOf, licenseFiles } from "./dependency.ts";
import { cleanUp, makeTree, sourceMap } from "./fixture.ts";
import { bundledSources } from "./sources.ts";

afterEach(cleanUp);

const dep = "node_modules/.pnpm/dep@1.0.0/node_modules/dep";

const tree = () =>
  makeTree({
    "packages/p/package.json": "{}",
    "packages/p/src/a.ts": "",
    "packages/p/dist/index.js": "",
    "packages/p/dist/index.js.map": sourceMap(
      "../src/a.ts",
      "../../q/dist/lib.js",
      "\0rolldown/runtime.js",
      `../../../${dep}/index.js`,
    ),
    "packages/p/dist/index.d.ts": "",
    "packages/q/src/b.ts": "",
    "packages/q/dist/lib.js": "",
    "packages/q/dist/lib.js.map": sourceMap("../src/b.ts"),
    [`${dep}/index.js`]: "",
    [`${dep}/LICENSE`]: "",
    [`${dep}/LICENSE-MIT.txt`]: "",
    [`${dep}/package.json`]: "{}",
  });

test("sources are followed through the maps of built files they name", async () => {
  const root = await tree();
  const { sources, problems } = await bundledSources(join(root, "packages/p"), {
    name: "p",
    files: ["dist", "LICENSES"],
  });
  expect(problems).toEqual([]);
  expect([...sources].sort()).toEqual(
    [join(root, dep, "index.js"), join(root, "packages/p/src/a.ts"), join(root, "packages/q/src/b.ts")].sort(),
  );
});

test("a packed script without a sourcemap is a problem", async () => {
  const root = await makeTree({ "packages/p/dist/index.js": "" });
  const { problems } = await bundledSources(join(root, "packages/p"), { name: "p", files: ["dist"] });
  expect(problems).toEqual(["dist/index.js has no sourcemap"]);
});

test("a copied directory's maps are read where it was built", async () => {
  const root = await tree();
  await mkdir(join(root, "packages/r/dist/host"), { recursive: true });
  await writeFile(join(root, "packages/r/dist/host/index.js"), "");
  const { sources, problems } = await bundledSources(join(root, "packages/r"), {
    name: "r",
    files: ["dist"],
    ibusWeb: { copiedFrom: { "dist/host": "../p/dist" } },
  });
  expect(problems).toEqual([]);
  expect(sources.has(join(root, "packages/p/src/a.ts"))).toBe(true);
});

test("a files entry that is a pattern is refused", async () => {
  const root = await tree();
  await expect(bundledSources(join(root, "packages/p"), { name: "p", files: ["dist/*.js"] })).rejects.toThrow(
    /pattern/,
  );
});

test("a dependency is named by the node_modules directory holding it", async () => {
  const root = await tree();
  expect(dependencyOf(join(root, dep, "index.js"))).toEqual({ name: "dep", dir: join(root, dep) });
  expect(dependencyOf(join(root, "node_modules/@scope/x/lib/y.js"))).toEqual({
    name: "@scope/x",
    dir: join(root, "node_modules/@scope/x"),
  });
  expect(dependencyOf(join(root, "packages/p/src/a.ts"))).toBeUndefined();
  expect(await licenseFiles(join(root, dep))).toEqual(["LICENSE", "LICENSE-MIT.txt"]);
});
