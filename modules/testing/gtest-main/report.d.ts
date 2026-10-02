// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the report library uses from the module's own scope, which isn't a
// library symbol: the environment it detected and, under Node, what Node
// provides.

declare const ENVIRONMENT_IS_NODE: boolean;

declare const process: {
  env: Record<string, string | undefined>;
  getBuiltinModule(id: "node:fs"): { writeFileSync(path: string, data: string): void };
};
