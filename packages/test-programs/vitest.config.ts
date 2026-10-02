// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { defineConfig } from "vitest/config";
import { testProgramsConfig } from "./src/node/config.ts";

export default defineConfig(testProgramsConfig());
