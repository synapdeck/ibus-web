// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The package's bundles, under dist/:
//
//   shared/index.js   what the page imports: the control buffer, the
//                     messages and the storage names, with its declarations.
//                     It shares the protocol transport exports with pages.
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
  // node:fs/promises is imported lazily, only when running under Node; a
  // browser never reaches that import.
  deps: {
    alwaysBundle: [/^@ibus-web\/protocol(?:\/|$)/, "effect", /^effect\//, /^brotli-dec-wasm/, "modern-tar"],
    neverBundle: [/^node:/],
    onlyBundle: false,
  },
});

export default defineConfig([
  {
    ...common,
    clean: true,
    entry: { "shared/index": "src/shared/index.ts" },
    tsconfig: "tsconfig.shared.json",
    dts: { generator: "oxc" },
    deps: { neverBundle: ["effect", /^effect\//] },
  },
  ...["worker", "test/worker"].map((directory): UserConfig => ({
    ...worker(`${directory}/brotli-fallback`, "src/worker/brotli-fallback.ts", "tsconfig.worker.json"),
    // The web bindings accept bytes directly; embedding them keeps each
    // lazily loaded fallback self-contained in both Node and browsers.
    loader: { ".wasm": "binary" },
  })),
  worker("worker/index", "src/worker/index.ts", "tsconfig.worker.json"),
  worker("worker/relay", "src/worker/relay.ts", "tsconfig.worker.json"),
  worker("test/worker/host", "test/worker/host.ts", "tsconfig.test-worker.json"),
  worker("test/worker/failing-relay", "test/worker/failing-relay.ts", "tsconfig.test-worker.json"),
]);
