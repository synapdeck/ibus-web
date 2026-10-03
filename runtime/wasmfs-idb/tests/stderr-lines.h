// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Waits for a line on stderr, as the program's main thread keeps them for
// a program linked with stderr-post.js. A line from another thread reaches
// the main thread as a message, so only its event loop hears it.

#pragma once

#include <string>

#include "idb-test.h"

// clang-format reads an EM_JS body as C and splits JavaScript's =>.
// clang-format off
EM_JS(void, idb_test_await_stderr, (em_proxying_ctx *ctx, const char *text, int *found), {
  wasmfsIdbTestAwaitStderr(UTF8ToString(text), (heard) => {
    HEAP32[found >> 2] = heard;
    _idb_test_finish(ctx);
  });
});
// clang-format on

namespace idb_test {

// Whether stderr has had a line holding `text`, waiting a while for one.
inline bool heard_on_stderr(const std::string &text) {
  int found = 0;
  on_main_thread([&](em_proxying_ctx *ctx) {
    idb_test_await_stderr(ctx, text.c_str(), &found);
  });
  return found;
}

} // namespace idb_test
