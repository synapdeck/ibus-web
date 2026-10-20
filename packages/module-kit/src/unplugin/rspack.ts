// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { unplugin, type IbusModuleOptions } from "./index.ts";

export type { IbusModuleOptions } from "./index.ts";

/** The plugin for Rspack. */
const plugin: (options?: IbusModuleOptions) => ReturnType<typeof unplugin.rspack> = unplugin.rspack;

export default plugin;
