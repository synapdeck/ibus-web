// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Waits for a line on stderr, as the program's main thread keeps the lines
// it prints in a program that links the post-js defining
// wasmfsIdbTestAwaitStderr. A line from another thread reaches the main
// thread as a message, so only its event loop hears it.

#pragma once

#include <string>

#include "idb-test.h"

// clang-format reads an EM_JS body as C and splits JavaScript's =>.
// clang-format off
EM_JS(void, idb_test_await_stderr, (void *call, uint32_t *out, const char *text), {
  wasmfsIdbTestAwaitStderr(UTF8ToString(text), (heard) => {
    HEAPU32[out >> 2] = heard;
    _idb_test_finish(call);
  });
});
// clang-format on

namespace idb_test {

// Whether stderr has had a line holding `text`, waiting a while for one.
inline bool heard_on_stderr(const std::string &text) {
  auto out = on_main_thread("waiting for stderr", [&](MainThreadCall *call) {
    idb_test_await_stderr(call, call->out, text.c_str());
  });
  return out && (*out)[0];
}

} // namespace idb_test
