// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: LGPL-2.1-or-later

#include "ops.h"

#include <cerrno>
#include <exception>

// An exception leaving an operation would unwind through the dispatcher's C
// frames, which can't catch it, and out of the runtime into the host; a C++
// frame between them is the only place to stop it.
int ibusweb_ops_call(uint32_t opcode, IBusWebOp op, const uint8_t *payload,
                     uint32_t len, GString *reply) {
  try {
    op(payload, len, reply);
    return 0;
  } catch (const std::exception &e) {
    g_warning("Operation %" G_GUINT32_FORMAT " threw: %s", opcode, e.what());
  } catch (...) {
    g_warning("Operation %" G_GUINT32_FORMAT " threw", opcode);
  }
  return -ECANCELED;
}
