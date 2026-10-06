// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { chromiumNotice, keysymNotice } from "./notices.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("notice extraction removes only source comment syntax", () => {
  expect(keysymNotice("/*****\nCopyright Example\n\n  All Rights Reserved\n\n*****/\n#define OTHER 1\n")).toBe(
    "Copyright Example\n\n  All Rights Reserved\n\n",
  );
  expect(chromiumNotice("// Copyright Example\n//\n//    * Retain this bullet.\n// Disclaimer.\n")).toBe(
    "Copyright Example\n\n   * Retain this bullet.\nDisclaimer.\n",
  );
});

test("canonical notices preserve the complete pinned upstream wording", () => {
  const x11 = readFileSync(process.env["IBUS_WEB_KEYSYMDEF"]!, "utf8");
  const chromium = readFileSync(process.env["IBUS_WEB_CHROMIUM_LICENSE"]!, "utf8");
  const x11Notice = keysymNotice(x11);
  const chromiumText = chromiumNotice(chromium);
  expect(readFileSync(join(root, "NOTICES/keysymdef.txt"), "utf8")).toBe(x11Notice);
  expect(readFileSync(join(root, "NOTICES/chromium.txt"), "utf8")).toBe(chromiumText);
  // Restoring only the pinned comment delimiters recovers every original byte.
  expect(
    "/***********************************************************\n" +
      x11Notice +
      "******************************************************************/",
  ).toBe(x11.slice(0, x11.indexOf("*/") + 2));
  expect(
    chromiumText
      .split("\n")
      .slice(0, -1)
      .map((line) => (line ? `// ${line}` : "//"))
      .join("\n") + "\n",
  ).toBe(chromium);
  expect(chromiumText).toContain("Copyright 2015 The Chromium Authors");
});

test("core pack ships clean complete notices and cleans package-local copies", () => {
  const directory = mkdtempSync(join(tmpdir(), "ibus-web-core-pack-"));
  try {
    for (const file of ["package.json", "pnpm-workspace.yaml", "LICENSE-MIT", "LICENSE-APACHE", "LICENSES"]) {
      cpSync(join(root, file), join(directory, file), { recursive: true });
    }
    cpSync(join(root, "NOTICES"), join(directory, "NOTICES"), { recursive: true });
    for (const name of ["core", "protocol", "worker-host"]) {
      const target = join(directory, "packages", name);
      mkdirSync(target, { recursive: true });
      cpSync(join(root, "packages", name, "package.json"), join(target, "package.json"));
    }
    const core = join(directory, "packages/core");
    mkdirSync(join(core, "node_modules/@ibus-web"), { recursive: true });
    for (const name of ["protocol", "worker-host"]) {
      symlinkSync(join(directory, "packages", name), join(core, "node_modules/@ibus-web", name));
    }
    cpSync(join(root, "packages/core/dist"), join(core, "dist"), { recursive: true });
    execFileSync("pnpm", ["pack", "--pack-destination", directory], { cwd: core, stdio: "pipe" });
    const archives = readdirSync(directory).filter((name) => name.endsWith(".tgz"));
    expect(archives).toHaveLength(1);
    const archive = join(directory, archives[0]!);
    const unpack = (file: string) => execFileSync("tar", ["-xOf", archive, `package/${file}`], { encoding: "utf8" });
    const files = execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).split("\n");
    expect(files).toContain("package/dist/page/index.js");
    expect(files).toContain("package/dist/shared/index.js");
    for (const file of [
      "LICENSE-MIT",
      "LICENSE-APACHE",
      "LICENSES/MIT-open-group.txt",
      "LICENSES/HPND.txt",
      "LICENSES/BSD-3-Clause.txt",
    ]) {
      expect(unpack(file)).toBe(readFileSync(join(root, file), "utf8"));
    }
    const x11 = unpack("LICENSES/keysymdef-notice.txt");
    const chromium = unpack("LICENSES/chromium-notice.txt");
    expect(x11).toBe(readFileSync(join(root, "NOTICES/keysymdef.txt"), "utf8"));
    expect(chromium).toBe(readFileSync(join(root, "NOTICES/chromium.txt"), "utf8"));
    expect.soft(x11).not.toMatch(/\/\*|\*\//);
    expect.soft(chromium).not.toMatch(/^\/\//m);
    expect(unpack("LICENSES/xkeyboard-config-COPYING.txt")).toBe(
      readFileSync(process.env["IBUS_WEB_XKB_NOTICE"]!, "utf8"),
    );
    expect.soft(existsSync(join(core, "LICENSES"))).toBe(false);
    expect(existsSync(join(core, "LICENSE-MIT"))).toBe(false);
    expect(existsSync(join(core, "LICENSE-APACHE"))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
