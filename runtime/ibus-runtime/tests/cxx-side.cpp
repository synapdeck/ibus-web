// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A C++ side module, which takes libc++ from the runtime rather than
// carrying its own.

#include <ibus-web/runtime.h>

#include <stdexcept>
#include <string>

// greet(name): "hello, " and the name, by way of an exception thrown and
// caught inside the module.
static void greet(const uint8_t *payload, uint32_t len, GString *reply) {
  std::string name(reinterpret_cast<const char *>(payload), len);
  try {
    throw std::runtime_error("hello, " + name);
  } catch (const std::runtime_error &e) {
    g_string_append(reply, e.what());
  }
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, 10, "greet", greet);
}
