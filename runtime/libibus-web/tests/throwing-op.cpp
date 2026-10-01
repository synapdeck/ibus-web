// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: LGPL-2.1-or-later

#include <ibus-web/runtime.h>
#include <stdexcept>

extern "C" void test_throwing_op(const uint8_t *, uint32_t, GString *reply) {
  // Partly written, so the test can tell the dispatcher dropped it.
  g_string_append(reply, "partial");
  throw std::runtime_error("thrown by an operation");
}
