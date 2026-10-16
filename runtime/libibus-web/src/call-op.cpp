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

// What a fault records for an exception that isn't a std::exception, which
// carries no what().
static const char unknown_exception[] =
    "an exception that isn't a std::exception";

int32_t ibusweb_dispatch_call(uint16_t kind, IBusWebDispatchCall call,
                              gpointer data) {
  try {
    return call(data);
  } catch (const std::exception &e) {
    g_warning("Request %u threw: %s", kind, e.what());
    ibusweb_runtime_fault(e.what());
  } catch (...) {
    g_warning("Request %u threw", kind);
    ibusweb_runtime_fault(unknown_exception);
  }
  return -ECANCELED;
}

// GLib calls signal handlers and source callbacks through this. Stopping the
// exception here, inside GLib's call, lets GLib finish the emission or the
// dispatch, so its state stays whole for the host to drain output and log
// through until it ends the engines; frames of the engine's own between the
// throw and here still skip their cleanup, so the engines are faulted.
void ibusweb_dispatch_hook(GWasmDispatchFunc func, gpointer data) {
  try {
    func(data);
  } catch (const std::exception &e) {
    g_warning("An engine threw: %s", e.what());
    ibusweb_runtime_fault(e.what());
  } catch (...) {
    g_warning("An engine threw %s", unknown_exception);
    ibusweb_runtime_fault(unknown_exception);
  }
}
