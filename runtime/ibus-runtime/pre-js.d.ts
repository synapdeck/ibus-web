// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What a --pre-js sees of the code Emscripten generates around it.

// Whether this is a pthread's Worker rather than the runtime's own thread.
declare const ENVIRONMENT_IS_PTHREAD: boolean;

// The settings the host passes the runtime's factory; only those a pre-js
// here reads.
declare const Module: {
  wasmMemory?: WebAssembly.Memory;
};
