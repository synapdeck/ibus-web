// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: LGPL-2.1-or-later

// Intentionally empty. A C++ source has Meson link the program with the C++
// driver, as a main module must be. link_language would do the same but
// also puts the compiler's search paths first, where wasm-ld then finds
// Emscripten's non-PIC system libraries instead of the main module's PIC
// ones.
