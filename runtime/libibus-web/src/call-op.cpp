// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: LGPL-2.1-or-later

#include "dispatch.h"
#include "ops.h"

#include <cerrno>
#include <exception>

// An exception leaving an operation would unwind through the dispatcher's C
// frames, which can't catch it, and out of the runtime into the host; a C++
// frame between them is the only place to stop it.
//
// Under -fwasm-exceptions, catch (...) catches the __cpp_exception tag, not
// everything as catch_all would, so only exceptions C++ code threw end up
// here. Foreign ones pass through to the host: JavaScript errors from JS
// library code, Emscripten's ExitStatus from exit() and its "unwind" from
// emscripten_exit_with_live_runtime(), and longjmp(), which travels under a
// tag of its own.
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

int32_t ibusweb_dispatch_call(uint16_t kind, IBusWebDispatchCall call,
                              gpointer data) {
  try {
    return call(data);
  } catch (const std::exception &e) {
    g_warning("Request %u threw: %s", kind, e.what());
  } catch (...) {
    g_warning("Request %u threw", kind);
  }
  return -ECANCELED;
}
