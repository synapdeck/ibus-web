// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What a --pre-js sees of the code Emscripten generates around it.

// Whether this is a pthread's Worker rather than the program's main thread.
declare const ENVIRONMENT_IS_PTHREAD: boolean;

// The settings the program reads at startup; only those a pre-js here sets.
declare const Module: {
  INITIAL_MEMORY?: number;
};
