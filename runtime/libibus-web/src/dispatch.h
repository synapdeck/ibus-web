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
/* Whether a request's exception has left the runtime unusable. */
G_GNUC_INTERNAL gboolean ibusweb_runtime_faulted(void);
G_END_DECLS
