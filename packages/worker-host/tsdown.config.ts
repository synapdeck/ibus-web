// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The package's bundles, under dist/:
//
//   shared/index.js   what the page imports: the control buffer, the
//                     messages and the storage names, with its declarations.
//                     It imports nothing; Effect is a peer dependency of the
//                     package, for pages that use it.
//   worker/index.js   the host's Worker script, which the page starts by URL.
//   worker/relay.js   the wake relay's Worker script, which the host starts
//                     by URL from beside its own.
//   test/worker/      the host's test build, the same host with its
//                     instruments, and a relay that fails on purpose. No
//                     export names them and they aren't published.
//
// Each Worker script is one self-contained module, Effect included, with no
// chunk shared with another: a Worker loads by URL, as it is on disk, so it
// can't resolve a bare import, and a page's bundler copies a script found by
// new URL(..., import.meta.url) as it is, without the chunks it imports.

import { copyFile, mkdir } from "node:fs/promises";
import { defineConfig, type UserConfig } from "tsdown";

const common = {
  format: "esm",
  platform: "neutral",
  fixedExtension: false,
  hash: false,
  clean: false,
  sourcemap: true,
  outDir: "dist",
} satisfies UserConfig;

// One Worker script, built alone so that it shares nothing with another.
const worker = (name: string, source: string, tsconfig: string): UserConfig => ({
  ...common,
  entry: { [name]: source },
  tsconfig,
  dts: false,
  // The Node store and mount import node:fs/promises only when running under
  // Node; a browser never reaches that import.
  deps: {
    alwaysBundle: ["effect", /^effect\//, /^brotli-dec-wasm/],
    neverBundle: [/^node:/],
    onlyBundle: false,
  },
});

export default defineConfig([
  {
    ...common,
    clean: true,
    entry: { "shared/index": "src/shared/index.ts" },
    tsconfig: "src/shared/tsconfig.json",
    dts: { generator: "oxc" },
    deps: { neverBundle: ["effect", /^effect\//] },
  },
  ...["worker", "test/worker"].map((directory): UserConfig => ({
    ...worker(`${directory}/brotli-fallback`, "src/worker/brotli-fallback.ts", "src/worker/tsconfig.json"),
    hooks: {
      "build:done": async () => {
        await mkdir(`dist/${directory}`, { recursive: true });
        await copyFile(
          new URL(import.meta.resolve("brotli-dec-wasm/web/bg.wasm")),
          `dist/${directory}/brotli_dec_wasm_bg.wasm`,
        );
      },
    },
  })),
  worker("worker/index", "src/worker/index.ts", "src/worker/tsconfig.json"),
  worker("worker/relay", "src/worker/relay.ts", "src/worker/tsconfig.json"),
  worker("test/worker/host", "test/worker/host.ts", "test/worker/tsconfig.json"),
  worker("test/worker/failing-relay", "test/worker/failing-relay.ts", "test/worker/tsconfig.json"),
]);
