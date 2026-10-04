// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The decode benchmark times wall-clock work, so it runs on its own rather than beside the
    // other suites. The parity suite needs what the C side recorded, which only its check builds.
    exclude: [...configDefaults.exclude, "test/bench/**", "test/parity/**"],
  },
});
