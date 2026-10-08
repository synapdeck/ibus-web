// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { cleanUp, makeTree } from "./fixture.ts";
import { LicenseError, MANIFEST, postpack, prepack } from "./pack.ts";

afterEach(cleanUp);

const setUp = async () => {
  const root = await makeTree({
    "LICENSE-MIT": "mit",
    "LICENSES/HPND.txt": "hpnd",
    "p/dist/index.js": "",
    "p/LICENSES/keep.txt": "keep",
  });
  const packageDir = join(root, "p");
  const plan = {
    copies: [
      { from: join(root, "LICENSE-MIT"), to: "LICENSE-MIT" },
      { from: join(root, "LICENSES/HPND.txt"), to: "LICENSES/HPND.txt" },
      { from: join(root, "LICENSES/HPND.txt"), to: "LICENSES/dep/LICENSE" },
    ],
    problems: [],
  };

  return { packageDir, plan };
};

test("prepack copies what the plan says and postpack removes exactly that", async () => {
  const { packageDir, plan } = await setUp();

  await prepack(packageDir, plan);

  expect(await readFile(join(packageDir, "LICENSES/dep/LICENSE"), "utf8")).toBe("hpnd");
  expect(JSON.parse(await readFile(join(packageDir, MANIFEST), "utf8"))).toEqual([
    "LICENSE-MIT",
    "LICENSES/HPND.txt",
    "LICENSES/dep/LICENSE",
  ]);

  await postpack(packageDir);

  expect(existsSync(join(packageDir, "LICENSE-MIT"))).toBe(false);
  expect(existsSync(join(packageDir, "LICENSES/dep"))).toBe(false);
  expect(existsSync(join(packageDir, MANIFEST))).toBe(false);
  expect(await readFile(join(packageDir, "LICENSES/keep.txt"), "utf8")).toBe("keep");
  expect(existsSync(join(packageDir, "dist/index.js"))).toBe(true);
});

test("prepack after an interrupted pack starts over", async () => {
  const { packageDir, plan } = await setUp();

  await prepack(packageDir, plan);
  await prepack(packageDir, plan);
  await postpack(packageDir);

  expect(existsSync(join(packageDir, "LICENSE-MIT"))).toBe(false);
});

test("prepack won't overwrite a file it didn't write", async () => {
  const { packageDir, plan } = await setUp();
  await writeFile(join(packageDir, "LICENSE-MIT"), "hand-written");

  await expect(prepack(packageDir, plan)).rejects.toThrow(/LICENSE-MIT/);
  expect(await readFile(join(packageDir, "LICENSE-MIT"), "utf8")).toBe("hand-written");
});

test("prepack refuses a plan with problems", async () => {
  const { packageDir, plan } = await setUp();

  await expect(prepack(packageDir, { ...plan, problems: ["x has no license"] })).rejects.toBeInstanceOf(LicenseError);
  expect(existsSync(join(packageDir, MANIFEST))).toBe(false);
});

test("postpack without a manifest does nothing", async () => {
  const { packageDir } = await setUp();

  await postpack(packageDir);

  expect(existsSync(join(packageDir, "LICENSES/keep.txt"))).toBe(true);
});

test.each([["../outside.txt"], ["/etc/passwd"], ["LICENSES/../../outside.txt"]])(
  "postpack refuses a manifest entry that leaves the package: %s",
  async (entry) => {
    const { packageDir, plan } = await setUp();
    await prepack(packageDir, plan);
    await writeFile(join(packageDir, "../outside.txt"), "outside");
    await writeFile(join(packageDir, MANIFEST), JSON.stringify(["LICENSE-MIT", entry]));

    await expect(postpack(packageDir)).rejects.toThrow(entry);
    expect(await readFile(join(packageDir, "../outside.txt"), "utf8")).toBe("outside");
    expect(existsSync(join(packageDir, "LICENSE-MIT"))).toBe(true);
  },
);
