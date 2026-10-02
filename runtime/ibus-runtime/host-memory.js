// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Without a memory from the host, Emscripten would make one that can grow.
// Pthread Workers are handed the runtime's memory by Emscripten instead.
if (!ENVIRONMENT_IS_PTHREAD && !Module["wasmMemory"])
  throw new Error(
    "ibus-runtime: the host must pass wasmMemory, a shared WebAssembly.Memory whose maximum is its initial size",
  );
