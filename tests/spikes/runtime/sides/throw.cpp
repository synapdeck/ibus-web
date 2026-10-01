// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#include "spike.h"

#include <stdexcept>

// throw(): never replies; the exception must cross into the runtime, whose
// dispatcher turns it into an error.
static void throw_op(const uint8_t *, uint32_t, GString *) {
  throw std::runtime_error("thrown by a spike side module");
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, SPIKE_OP_THROW, "throw", throw_op);
}
