// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The decode benchmark times wall-clock work, so it runs on its own rather than beside the
    // other suites.
    exclude: [...configDefaults.exclude, "test/bench/**"],
  },
});
