// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The package's bundles, under dist/:
//
//   shared/index.js   what the page imports: the control buffer, the
//                     messages and the storage names, with its declarations.
//   worker/index.js   the host's Worker script, which the page starts by URL.
//   worker/relay.js   the wake relay's Worker script, which the host starts
//                     by URL from beside its own.
//   test/worker/      the host's test build, with its instruments, and a
//                     relay that fails on purpose. No export names them and
//                     they aren't published.
//
// Each Worker script is an entry of its own, never inlined into another.
// Effect is a peer dependency, so the package's bundles import it. The test
// build bundles it instead: tests load it by URL as it is on disk, and a
// browser can't resolve a bare import from a Worker.

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

export default defineConfig([
  {
    ...common,
    entry: { "shared/index": "src/shared/index.ts" },
    tsconfig: "src/shared/tsconfig.json",
    dts: { generator: "oxc" },
  },
  {
    ...common,
    entry: { "worker/index": "src/worker/index.ts", "worker/relay": "src/worker/relay.ts" },
    tsconfig: "src/worker/tsconfig.json",
    dts: false,
    deps: { neverBundle: ["effect", /^effect\//] },
    outputOptions: { chunkFileNames: "worker/[name].js" },
  },
  {
    ...common,
    entry: { "test/worker/host": "test/worker/host.ts", "test/worker/failing-relay": "test/worker/failing-relay.ts" },
    tsconfig: "test/worker/tsconfig.json",
    dts: false,
    deps: { alwaysBundle: ["effect", /^effect\//], onlyBundle: false },
    outputOptions: { chunkFileNames: "test/worker/[name].js" },
  },
]);
