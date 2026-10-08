// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { KEY, cleanUp, makeTree, own, sourceMap } from "./fixture.ts";
import { planLicenses } from "./plan.ts";

afterEach(cleanUp);

const dep = "node_modules/.pnpm/dep@1.0.0/node_modules/dep";

const repository = (extra: Readonly<Record<string, string>> = {}) =>
  makeTree({
    "REUSE.toml": `version = 1

[[annotations]]
path = "packages/p/src/table.ts"
${KEY} = "MIT-open-group AND HPND"
precedence = "override"
`,
    "LICENSE-MIT": "mit",
    "LICENSE-APACHE": "apache",
    "LICENSES/MIT-open-group.txt": "",
    "LICENSES/HPND.txt": "",
    "NOTICES/keysymdef.txt": "",
    "packages/p/package.json": JSON.stringify({ name: "p", files: ["dist"] }),
    "packages/p/src/a.ts": own(),
    "packages/p/src/table.ts": "",
    "packages/p/dist/index.js": "",
    [`${dep}/index.js`]: "",
    [`${dep}/LICENSE`]: "",
    ...extra,
  });

const tos = (plan: { copies: readonly { to: string }[] }) => plan.copies.map((copy) => copy.to);

test("code under the repository's own license needs only its two license files", async () => {
  const root = await repository({ "packages/p/dist/index.js.map": sourceMap("../src/a.ts") });
  const plan = await planLicenses(root, join(root, "packages/p"), {});

  expect(plan.problems).toEqual([]);
  expect(tos(plan)).toEqual(["LICENSE-APACHE", "LICENSE-MIT"]);
  expect(plan.copies[1]?.from).toBe(join(root, "LICENSE-MIT"));
});

test("third-party repository files bring their license texts and notices", async () => {
  const root = await repository({ "packages/p/dist/index.js.map": sourceMap("../src/a.ts", "../src/table.ts") });
  const plan = await planLicenses(root, join(root, "packages/p"), {
    "packages/p/src/table.ts": ["NOTICES/keysymdef.txt"],
  });

  expect(plan.problems).toEqual([]);
  expect(tos(plan)).toEqual([
    "LICENSE-APACHE",
    "LICENSE-MIT",
    "LICENSES/HPND.txt",
    "LICENSES/MIT-open-group.txt",
    "LICENSES/keysymdef-notice.txt",
  ]);
});

test("a bundled dependency brings its own license files", async () => {
  const root = await repository({ "packages/p/dist/index.js.map": sourceMap(`../../../${dep}/index.js`) });
  const plan = await planLicenses(root, join(root, "packages/p"), {});

  expect(plan.problems).toEqual([]);
  expect(tos(plan)).toContain("LICENSES/dep/LICENSE");
});

test("whatever can't be accounted for is a problem", async () => {
  const root = await repository({
    "packages/p/dist/index.js.map": sourceMap(
      "../src/bare.ts",
      "../src/gone.ts",
      "../src/gpl.ts",
      "../../../node_modules/nolicense/index.js",
    ),
    "packages/p/src/bare.ts": "export {};\n",
    "packages/p/src/gpl.ts": `// ${KEY}: GPL-2.0-or-later\n`,
    "node_modules/nolicense/index.js": "",
  });
  const plan = await planLicenses(root, join(root, "packages/p"), { "packages/p/src/x.ts": ["NOTICES/x.txt"] });

  expect([...plan.problems].sort()).toEqual(
    [
      "notice map names packages/p/src/x.ts, which doesn't exist",
      "notice map names NOTICES/x.txt, which doesn't exist",
      "packages/p/src/bare.ts has no license",
      "packages/p/src/gone.ts is bundled but missing",
      "packages/p/src/gpl.ts is GPL-2.0-or-later, but LICENSES/GPL-2.0-or-later.txt is missing",
      "nolicense has no license file",
    ].sort(),
  );
});

test("two dependencies with the same name and different texts are a problem", async () => {
  const other = "node_modules/.pnpm/dep@2.0.0/node_modules/dep";
  const root = await repository({
    "packages/p/dist/index.js.map": sourceMap(`../../../${dep}/index.js`, `../../../${other}/index.js`),
    [`${other}/index.js`]: "",
    [`${other}/LICENSE`]: "different",
  });
  const plan = await planLicenses(root, join(root, "packages/p"), {});

  expect(plan.problems).toEqual([expect.stringContaining("LICENSES/dep/LICENSE")]);
});

test("two dependencies with the same name and the same text are fine", async () => {
  const other = "node_modules/.pnpm/dep@2.0.0/node_modules/dep";
  const root = await repository({
    "packages/p/dist/index.js.map": sourceMap(`../../../${dep}/index.js`, `../../../${other}/index.js`),
    [`${dep}/LICENSE`]: "same",
    [`${other}/index.js`]: "",
    [`${other}/LICENSE`]: "same",
  });
  const plan = await planLicenses(root, join(root, "packages/p"), {});

  expect(plan.problems).toEqual([]);
  expect(tos(plan)).toContain("LICENSES/dep/LICENSE");
});

test("a bundled dependency whose directory is gone is a problem, not a crash", async () => {
  const root = await repository({
    "packages/p/dist/index.js.map": sourceMap("../../../node_modules/.pnpm/gone@1.0.0/node_modules/gone/index.js"),
  });
  const plan = await planLicenses(root, join(root, "packages/p"), {});

  expect(plan.problems).toEqual([
    "gone is bundled from node_modules/.pnpm/gone@1.0.0/node_modules/gone, which is missing; rebuild",
  ]);
});
