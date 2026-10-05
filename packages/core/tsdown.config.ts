// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { defineConfig } from "tsdown";
export default defineConfig({
  entry: { keys: "src/keys/index.ts" },
  platform: "neutral",
  dts: { generator: "tsgo" },
  deps: { neverBundle: ["effect", /^effect\//] },
  tsconfig: "src/tsconfig.json",
});
