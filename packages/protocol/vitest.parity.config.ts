// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/parity/**/*.test.ts"],
  },
});
