// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#include <ibus-web/runtime.h>

#include <stdexcept>

// throw(): never replies; the exception unwinds out of the module into the
// runtime, whose dispatcher catches it.
static void throw_op(const uint8_t *, uint32_t, GString *) {
  throw std::runtime_error("thrown in a side module");
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, 11, "throw", throw_op);
}
