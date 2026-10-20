// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { unplugin, type IbusModuleViteOptions } from "./index.ts";

export type { IbusModuleViteOptions } from "./index.ts";

/** The plugin for Vite. */
const plugin: (options?: IbusModuleViteOptions) => ReturnType<typeof unplugin.vite> = unplugin.vite;

export default plugin;
