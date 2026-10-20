// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The kit, which a module's bundle inlines into its Worker script, and the
// build entry and bundler plugins, which run under Node. They share no chunk,
// so the kit's bundle never reaches for Node.

import { defineConfig, type UserConfig } from "tsdown";

const common = {
  sourcemap: true,
  clean: false,
  fixedExtension: false,
  dts: { generator: "tsgo" },
} satisfies UserConfig;

export default defineConfig([
  {
    ...common,
    entry: { index: "src/index.ts" },
    platform: "neutral",
    deps: { neverBundle: [/^@ibus-web\//] },
    tsconfig: "tsconfig.worker.json",
  },
  {
    ...common,
    entry: {
      build: "src/build/index.ts",
      cli: "src/build/cli.ts",
      unplugin: "src/unplugin/index.ts",
      vite: "src/unplugin/vite.ts",
      rollup: "src/unplugin/rollup.ts",
      rolldown: "src/unplugin/rolldown.ts",
      esbuild: "src/unplugin/esbuild.ts",
      webpack: "src/unplugin/webpack.ts",
      rspack: "src/unplugin/rspack.ts",
      "build-worker": "src/unplugin/build-worker.ts",
    },
    platform: "node",
    deps: { neverBundle: [/^@ibus-web\//, "es-module-lexer", "unplugin", "vite", /^node:/] },
    tsconfig: "tsconfig.node.json",
  },
]);
