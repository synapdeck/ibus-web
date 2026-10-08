// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  platform: "browser",
  sourcemap: true,
  dts: { generator: "tsgo" },
  deps: { neverBundle: ["effect", /^effect\//, /^@ibus-web\//] },
  tsconfig: "tsconfig.page.json",
});
