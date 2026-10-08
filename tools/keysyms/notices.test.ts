// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { chromiumNotice, keysymNotice } from "./notices.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

const workspaceDirectories = (): string[] => {
  const patterns = [...readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").matchAll(/^ {2}- (\S+)$/gm)].map(
    (match) => match[1]!,
  );
  return patterns.flatMap((pattern) =>
    pattern.endsWith("/*")
      ? readdirSync(join(root, pattern.slice(0, -2)), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${pattern.slice(0, -2)}/${entry.name}`)
      : [pattern],
  );
};

// pnpm pack rewrites each `workspace:` specifier by reading the dependency's package.json, so the
// fake workspace needs exactly core's direct workspace packages.
const coreWorkspaceDependencies = (): Map<string, string> => {
  const manifest = JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8")) as Record<
    "dependencies" | "devDependencies",
    Record<string, string> | undefined
  >;
  const wanted = new Set(
    [manifest.dependencies, manifest.devDependencies].flatMap((group) =>
      Object.entries(group ?? {})
        .filter(([, specifier]) => specifier.startsWith("workspace:"))
        .map(([name]) => name),
    ),
  );
  const directories = new Map<string, string>();
  for (const directory of workspaceDirectories()) {
    const { name } = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")) as { name: string };
    if (wanted.has(name)) directories.set(name, directory);
  }
  return directories;
};

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

    const dependencies = coreWorkspaceDependencies();
    for (const workspaceDirectory of ["packages/core", ...dependencies.values()]) {
      const target = join(directory, workspaceDirectory);
      mkdirSync(target, { recursive: true });
      cpSync(join(root, workspaceDirectory, "package.json"), join(target, "package.json"));
    }

    const core = join(directory, "packages/core");
    for (const [name, workspaceDirectory] of dependencies) {
      const link = join(core, "node_modules", name);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(join(directory, workspaceDirectory), link);
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
