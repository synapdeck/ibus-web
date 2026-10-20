// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The kit-built fixture module, bundled the way a module's build ships it:
// one ES module file with Effect and the kit inlined.

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import type { JsModuleManifest } from "@ibus-web/protocol";
import { build } from "tsdown";

const fixture = new URL("../fixtures/kit-module/", import.meta.url);

export interface BundledKitModule {
  readonly manifest: JsModuleManifest;
  readonly bytes: number;
  readonly gzipped: number;
  readonly remove: () => void;
}

export const bundleKitModule = async (minify = false): Promise<BundledKitModule> => {
  const directory = mkdtempSync(join(tmpdir(), "ibus-web-kit-module-"));

  await build({
    config: false,
    logLevel: "silent",
    entry: { module: new URL("module.ts", fixture).pathname },
    outDir: directory,
    format: "esm",
    platform: "neutral",
    fixedExtension: true,
    dts: false,
    clean: false,
    minify,
    deps: { alwaysBundle: [/^@ibus-web\//, "effect", /^effect\//], onlyBundle: false },
  });

  const path = join(directory, "module.mjs");
  const source = readFileSync(path);
  const base = JSON.parse(readFileSync(new URL("manifest.json", fixture), "utf8")) as JsModuleManifest;

  return {
    manifest: { ...base, module: { url: pathToFileURL(path).href, size: statSync(path).size } },
    bytes: source.length,
    gzipped: gzipSync(source).length,
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
};
