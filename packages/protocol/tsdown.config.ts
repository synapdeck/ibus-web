// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { defineConfig } from "tsdown";
export default defineConfig({
  entry: { index: "src/index.ts" },
  platform: "neutral",
  dts: { generator: "oxc" },
  deps: { neverBundle: ["effect", /^effect\//] },
  tsconfig: "src/tsconfig.json",
});
