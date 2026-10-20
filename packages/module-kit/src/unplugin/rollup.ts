// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { unplugin, type IbusModuleRollupOptions } from "./index.ts";

export type { IbusModuleRollupOptions } from "./index.ts";

/** The plugin for Rollup. */
const plugin: (options?: IbusModuleRollupOptions) => ReturnType<typeof unplugin.rollup> = unplugin.rollup;

export default plugin;
