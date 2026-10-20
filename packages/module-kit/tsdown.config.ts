// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  platform: "neutral",
  sourcemap: true,
  dts: { generator: "tsgo" },
  deps: { neverBundle: [/^@ibus-web\//] },
  tsconfig: "tsconfig.worker.json",
});
