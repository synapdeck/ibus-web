// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkInventory, expandVersionTemplate, parseInventory, upstreamPath } from "./inventory.ts";

const hash = "sha256-AAAA";

function readme(rows: [string, string][], version = "1.5.34", sourceHash = hash): string {
  return [
    "# IBus source inventory",
    "",
    `Imported from IBus ${version}, released upstream.`,
    `The unpacked-source hash is \`${sourceHash}\`.`,
    "",
    "| File | Origin and purpose; changes |",
    "| ---- | --------------------------- |",
    ...rows.map(([path, description]) => `| \`${path}\` | ${description} |`),
    "",
  ].join("\n");
}

const rows: [string, string][] = [
  ["src/ibus/README.md", "Ours: this inventory."],
  ["src/ibus/ibuskeys.c", "Upstream key names; unchanged."],
  ["src/ibus/ibustext.c", "Upstream text; exact signatures."],
  ["src/ibus/ibusengine.c", "Ours, a reimplementation."],
  ["src/ibus/org.freedesktop.ibus.gschema.xml", "Upstream schemas; unchanged."],
  ["include/ibus-1.0/ibusversion.h", "Generated from the upstream template with release 1.5.34."],
];

describe("parseInventory", () => {
  test("reads the release, hash and each row's origin", () => {
    const inventory = parseInventory(readme(rows));
    expect(inventory.version).toBe("1.5.34");
    expect(inventory.hash).toBe(hash);
    expect(inventory.rows.map((row) => [row.path, row.origin])).toEqual([
      ["src/ibus/README.md", "ours"],
      ["src/ibus/ibuskeys.c", "unchanged"],
      ["src/ibus/ibustext.c", "adapted"],
      ["src/ibus/ibusengine.c", "ours"],
      ["src/ibus/org.freedesktop.ibus.gschema.xml", "unchanged"],
      ["include/ibus-1.0/ibusversion.h", "generated"],
    ]);
  });

  test("rejects a duplicate row", () => {
    expect(() => parseInventory(readme([rows[1]!, rows[1]!]))).toThrow(/duplicate inventory entry/);
  });

  test("rejects a row without an origin", () => {
    expect(() => parseInventory(readme([["src/ibus/x.c", "Something else."]]))).toThrow(/must start with/);
  });
});

describe("upstreamPath", () => {
  test("maps sources and headers to src/ and schemas to data/dconf/", () => {
    expect(upstreamPath("include/ibus-1.0/ibustext.h")).toBe("src/ibustext.h");
    expect(upstreamPath("src/ibus/ibuskeys.c")).toBe("src/ibuskeys.c");
    expect(upstreamPath("src/ibus/org.freedesktop.ibus.gschema.xml")).toBe(
      "data/dconf/org.freedesktop.ibus.gschema.xml",
    );
  });
});

describe("expandVersionTemplate", () => {
  test("substitutes the release's parts", () => {
    expect(expandVersionTemplate("(@IBUS_MAJOR_VERSION@.@IBUS_MINOR_VERSION@.@IBUS_MICRO_VERSION@)", "1.5.34")).toBe(
      "(1.5.34)",
    );
  });

  test("rejects a substitution it has no value for", () => {
    expect(() => expandVersionTemplate("@IBUS_API_VERSION@", "1.5.34")).toThrow(/no value/);
  });
});

describe("checkInventory", () => {
  let base: string;
  let root: string;
  let upstream: string;
  const template = "#define IBUS_MICRO_VERSION (@IBUS_MICRO_VERSION@)\n";

  async function put(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  async function check(overrides: { readme?: string; version?: string; hash?: string } = {}): Promise<string[]> {
    await writeFile(join(root, "src/ibus/README.md"), overrides.readme ?? readme(rows));
    return checkInventory({
      root,
      readme: join(root, "src/ibus/README.md"),
      upstream,
      version: overrides.version ?? "1.5.34",
      hash: overrides.hash ?? hash,
    });
  }

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "vendor-inventory-"));
    root = join(base, "root");
    upstream = join(base, "upstream");
    await put(join(upstream, "src/ibuskeys.c"), "keys\n");
    await put(join(upstream, "src/ibustext.c"), "text\n");
    await put(join(upstream, "src/ibusengine.c"), "engine over D-Bus\n");
    await put(join(upstream, "src/ibusversion.h.in"), template);
    await put(join(upstream, "data/dconf/org.freedesktop.ibus.gschema.xml"), "<schemalist/>\n");
    await put(join(root, "src/ibus/ibuskeys.c"), "keys\n");
    await put(join(root, "src/ibus/ibustext.c"), "text, adapted\n");
    await put(join(root, "src/ibus/ibusengine.c"), "engine over records\n");
    await put(join(root, "src/ibus/org.freedesktop.ibus.gschema.xml"), "<schemalist/>\n");
    await put(join(root, "include/ibus-1.0/ibusversion.h"), "#define IBUS_MICRO_VERSION (34)\n");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("accepts a tree matching its inventory and release", async () => {
    expect(await check()).toEqual([]);
  });

  test("fails when the build's IBus is another release", async () => {
    expect(await check({ version: "1.5.35" })).toEqual(
      expect.arrayContaining([
        "inventory imports IBus 1.5.34, but the IBus source is 1.5.35",
        "include/ibus-1.0/ibusversion.h: differs from src/ibusversion.h.in generated for 1.5.35",
      ]),
    );
  });

  test("fails when the source hash differs", async () => {
    expect(await check({ hash: "sha256-BBBB" })).toEqual([
      "inventory's source hash is sha256-AAAA, but the IBus source's is sha256-BBBB",
    ]);
  });

  test("fails when an unchanged file differs from upstream", async () => {
    await writeFile(join(root, "src/ibus/ibuskeys.c"), "keys, edited\n");
    expect(await check()).toEqual(["src/ibus/ibuskeys.c: marked unchanged, but differs from upstream src/ibuskeys.c"]);
  });

  test("fails when an adapted file is identical to upstream", async () => {
    await writeFile(join(root, "src/ibus/ibustext.c"), "text\n");
    expect(await check()).toEqual(["src/ibus/ibustext.c: identical to upstream, so should be marked unchanged"]);
  });

  test("fails when an upstream file has no counterpart", async () => {
    await rm(join(upstream, "src/ibustext.c"));
    expect(await check()).toEqual(["src/ibus/ibustext.c: upstream has no src/ibustext.c"]);
  });

  test("fails when a generated file isn't the template's expansion", async () => {
    await writeFile(join(root, "include/ibus-1.0/ibusversion.h"), "#define IBUS_MICRO_VERSION  (34)\n");
    expect(await check()).toEqual([
      "include/ibus-1.0/ibusversion.h: differs from src/ibusversion.h.in generated for 1.5.34",
    ]);
  });

  test("fails on files missing from or stale in the inventory", async () => {
    await put(join(root, "src/ibus/extra.c"), "\n");
    await rm(join(root, "src/ibus/ibusengine.c"));
    expect(await check()).toEqual(["not in the inventory: src/ibus/extra.c", "no such file: src/ibus/ibusengine.c"]);
  });
});
