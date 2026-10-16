// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: LGPL-2.1-or-later
#include <glib-object.h>
#include <stdexcept>

extern "C" gboolean test_throwing_source(gpointer) {
  throw std::runtime_error("thrown by a source");
}

static void throwing_handler(gpointer, gpointer) {
  throw std::runtime_error("thrown by a handler");
}

// Invokes a closure whose handler throws, and says whether GLib finished
// the invocation: the closure is no longer marked as being marshalled.
extern "C" gboolean test_invoke_throwing_closure(void) {
  GClosure *closure =
      g_cclosure_new(G_CALLBACK(throwing_handler), nullptr, nullptr);
  g_closure_ref(closure);
  g_closure_sink(closure);
  g_closure_set_marshal(closure, g_cclosure_marshal_VOID__VOID);

  GValue instance = G_VALUE_INIT;
  g_value_init(&instance, G_TYPE_POINTER);
  g_closure_invoke(closure, nullptr, 1, &instance, nullptr);
  gboolean whole = !closure->in_marshal;
  g_closure_unref(closure);
  return whole;
}
