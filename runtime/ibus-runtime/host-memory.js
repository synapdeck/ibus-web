// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Without a memory from the host, Emscripten would make one of the least
// size the runtime takes rather than the size its engine needs. Pthread
// Workers are handed the runtime's memory by Emscripten instead.
if (!ENVIRONMENT_IS_PTHREAD && !Module["wasmMemory"])
  throw new Error("ibus-runtime: the host must pass wasmMemory, a shared WebAssembly.Memory of the engine's size");
