// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts", transport: "src/transport/index.ts", "module-script": "src/module-script.ts" },
  platform: "neutral",
  sourcemap: true,
  dts: { generator: "tsgo" },
  deps: { neverBundle: ["effect", /^effect\//] },
  tsconfig: "tsconfig.shared.json",
});
