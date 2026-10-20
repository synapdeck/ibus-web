// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const packageDir = fileURLToPath(new URL("../", import.meta.url));

// The type assertions in test/types hold only if the tests' configuration
// compiles without an error, an unused @ts-expect-error being one.
test("the kit's types accept a module satisfying the contract and refuse its mistakes", () => {
  const tsc = join(packageDir, "node_modules/typescript/bin/tsc");
  let output = "";
  try {
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.test.json", "--pretty", "false"], {
      cwd: packageDir,
      encoding: "utf8",
    });
  } catch (error) {
    output = (error as { stdout: string }).stdout;
  }

  expect(output.split("\n").filter((line) => / error TS/.test(line))).toEqual([]);
}, 60_000);
