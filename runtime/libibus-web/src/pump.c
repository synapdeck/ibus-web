/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

#include "ibus-web/runtime.h"

/* Sources that stay ready would keep the pump from ever returning to the
 * host; past this many rounds it returns 0 instead. */
#define MAX_ROUNDS 64

/* An fd turning ready doesn't signal the context's wakeup, so while a source
 * polls one, the host must come back to probe it at least this often. */
#define FD_PROBE_MSEC 10

int32_t ibusweb_pump(void) {
  GMainContext *context = g_main_context_default();
  GPollFunc poll_func = g_main_context_get_poll_func(context);
  /* Per call rather than cached, so a source can pump from its dispatch. */
  GPollFD stack_fds[8];
  GPollFD *fds = stack_fds;
  gint n_allocated = G_N_ELEMENTS(stack_fds);
  gint32 delay = 0;

  if (!g_main_context_is_owner(context)) {
    g_critical("ibusweb_pump() called off the thread that owns the default "
               "main context");
    return IBUSWEB_PUMP_ERROR;
  }

  /* An iteration taken apart, as g_main_context_iteration() would run it
   * without blocking, to keep the timeout its query computes. */
  for (int round = 0; round < MAX_ROUNDS; round++) {
    gint max_priority;
    gint timeout;
    gint n_fds;

    g_main_context_prepare(context, &max_priority);
    while ((n_fds = g_main_context_query(context, max_priority, &timeout, fds,
                                         n_allocated)) > n_allocated) {
      if (fds != stack_fds)
        g_free(fds);
      fds = g_new(GPollFD, n_fds);
      n_allocated = n_fds;
    }
    if (n_fds > 0)
      poll_func(fds, n_fds, 0);

    if (g_main_context_check(context, max_priority, fds, n_fds)) {
      g_main_context_dispatch(context);
      continue;
    }

    if (n_fds > 0 && (timeout < 0 || timeout > FD_PROBE_MSEC))
      timeout = FD_PROBE_MSEC;
    delay = timeout;
    break;
  }

  if (fds != stack_fds)
    g_free(fds);
  return delay;
}
