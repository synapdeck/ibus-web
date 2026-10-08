// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: { "shared/index": "src/shared/index.ts" },
    platform: "neutral",
    sourcemap: true,
    dts: { generator: "tsgo" },
    deps: { neverBundle: ["effect", /^effect\//, /^@ibus-web\//] },
    tsconfig: "tsconfig.shared.json",
  },
  {
    entry: { "page/index": "src/page/index.ts" },
    platform: "browser",
    sourcemap: true,
    dts: { generator: "tsgo" },
    deps: { neverBundle: ["effect", /^effect\//, /^@ibus-web\//] },
    tsconfig: "tsconfig.page.json",
  },
]);
