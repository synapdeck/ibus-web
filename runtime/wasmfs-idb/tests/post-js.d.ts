// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What a --post-js sees of the module it is appended to.

declare const ENVIRONMENT_IS_PTHREAD: boolean;

// The settings object the module's factory was given.
declare const Module: { printErr?: (text: string) => void };
