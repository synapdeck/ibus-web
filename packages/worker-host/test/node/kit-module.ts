// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The kit-built fixture module, bundled the way a module's build ships it,
// one ES module file with Effect and the kit inlined, and built into its
// manifest, script and settings metadata by the kit's post-processor.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { buildModule } from "@ibus-web/module-kit/build";
import type { JsModuleManifest } from "@ibus-web/protocol";
import { Effect } from "effect";
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

  const source = readFileSync(join(directory, "module.mjs"));
  const outDir = join(directory, "module");
  const { manifest } = await Effect.runPromise(buildModule({ script: source, outDir }));

  // The host resolves the script's URL against the manifest's only when it
  // fetches the manifest, which Node's fetch can't do from a file, so the
  // host is handed the manifest with the URL already resolved.
  const url = new URL(manifest.module.url, pathToFileURL(`${outDir}/`)).href;

  return {
    manifest: { ...manifest, module: { ...manifest.module, url } },
    bytes: source.length,
    gzipped: gzipSync(source).length,
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
};
