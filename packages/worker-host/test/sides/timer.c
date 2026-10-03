/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#include "spike.h"

#include <errno.h>

typedef enum { IDLE, PENDING, DONE } State;

/* Only touched on the pumping thread. */
static State state;
static gint64 added;
static int32_t delay;

static gboolean record(gpointer data) {
  (void)data;
  delay = (int32_t)MIN(g_get_monotonic_time() - added, G_MAXINT32);
  state = DONE;
  return G_SOURCE_REMOVE;
}

/* timeout(ms): adds a ms timeout to the default context. */
static void timeout(const uint8_t *payload, uint32_t len, GString *reply) {
  int32_t ms;
  if (!spike_arg(payload, len, 0, &ms) || ms < 0)
    return;
  if (state == PENDING) {
    spike_reply(reply, -EBUSY);
    return;
  }
  state = PENDING;
  added = g_get_monotonic_time();
  g_timeout_add((guint)ms, record, NULL);
  spike_reply(reply, 0);
}

/* timeout-result(): microseconds from the add to the dispatch. */
static void timeout_result(const uint8_t *payload, uint32_t len,
                           GString *reply) {
  (void)payload;
  (void)len;
  switch (state) {
  case IDLE:
    spike_reply(reply, -ENOENT);
    break;
  case PENDING:
    spike_reply(reply, -EAGAIN);
    break;
  case DONE:
    spike_reply(reply, delay);
    break;
  }
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, SPIKE_OP_TIMEOUT, "timeout", timeout);
  ibusweb_module_add_op(module, SPIKE_OP_TIMEOUT_RESULT, "timeout-result",
                        timeout_result);
}
