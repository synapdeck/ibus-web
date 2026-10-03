// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// For a check's own test files, which run in the node environment beside
// its programs.

import { inject } from "vitest";
import type {} from "../shared/protocol.ts";

// The string the check gave the test files under key.
export const nodeTestData = (key: string): string => {
  const value = inject("nodeTestData")[key];
  if (value === undefined) throw new Error(`the check gives the test files no ${key}`);
  return value;
};
