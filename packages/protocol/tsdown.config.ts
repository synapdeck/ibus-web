// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The module-script subpath is built alone: a module script bundles it, so it
// must import nothing, not even a chunk it would otherwise share with the
// main entry, which uses its constants too.

import { defineConfig, type UserConfig } from "tsdown";

const common = {
  platform: "neutral",
  sourcemap: true,
  clean: false,
  dts: { generator: "tsgo" },
  deps: { neverBundle: ["effect", /^effect\//] },
  tsconfig: "tsconfig.shared.json",
} satisfies UserConfig;

export default defineConfig([
  {
    ...common,
    entry: {
      index: "src/index.ts",
      transport: "src/transport/index.ts",
      descriptor: "src/descriptor.ts",
    },
  },
  { ...common, entry: { "module-script": "src/module-script.ts" } },
]);
