// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
export * from "@ibus-web/core";
export * from "@ibus-web/protocol";

// Core and the protocol both name a settings instance; this entry point exposes core's.
export type { SettingsInstance } from "@ibus-web/core";
