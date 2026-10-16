/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#pragma once
#include <glib.h>
#include <stdint.h>

G_BEGIN_DECLS
typedef int32_t (*IBusWebDispatchCall)(gpointer data);
G_GNUC_INTERNAL int32_t ibusweb_dispatch_call(uint16_t kind,
                                              IBusWebDispatchCall call,
                                              gpointer data);
G_GNUC_INTERNAL void ibusweb_log_init(void);
/* Marks the engines faulted, keeping the first reason, and wakes the host.
 * Any thread. */
G_GNUC_INTERNAL void ibusweb_runtime_fault(const char *reason);
/* Whether an engine's exception has left the engines unusable. */
G_GNUC_INTERNAL gboolean ibusweb_runtime_faulted(void);
/* Whether no request or source may reach an engine again: they faulted, or
 * Shutdown has run. Pumping thread only. */
G_GNUC_INTERNAL gboolean ibusweb_runtime_stopped(void);
/* Bumps the wake word and wakes its waiters, once ibusweb_runtime_init() has
 * set it. Any thread. */
G_GNUC_INTERNAL void ibusweb_runtime_wake(void);
/* GLib's dispatch hook: calls func inside a C++ try, faulting the engines
 * with what an exception says. On the pumping thread, once they are faulted,
 * it calls nothing. */
G_GNUC_INTERNAL void ibusweb_dispatch_hook(GWasmDispatchFunc func,
                                           gpointer data);
G_END_DECLS
