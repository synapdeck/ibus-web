/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#include "spike.h"

#include <errno.h>

/* Never more threads than a host could mean to test the pool with. */
#define MAX_SPAWN 64

typedef enum { IDLE, PENDING, DONE } State;

/* Each operation's state is only touched on the pumping thread, except
 * where noted. */
static State idle_state;
static gint64 idle_attached; /* written by the sleeping thread */
static gint64 idle_delay;

static State spawn_state;
static int32_t spawn_joined;
static gint spawn_ran; /* (atomic) */

static gboolean record_dispatch(gpointer data) {
  (void)data;
  idle_delay = g_get_monotonic_time() - idle_attached;
  idle_state = DONE;
  return G_SOURCE_REMOVE;
}

static gpointer sleep_then_idle(gpointer ms) {
  g_usleep((gulong)GPOINTER_TO_INT(ms) * G_TIME_SPAN_MILLISECOND);
  /* Read before the attach, so the delay covers the whole wake path. */
  idle_attached = g_get_monotonic_time();
  g_idle_add(record_dispatch, NULL);
  return NULL;
}

/* idle-later(ms): a thread sleeps ms, then attaches an idle source to the
 * default context from off the pumping thread. */
static void idle_later(const uint8_t *payload, uint32_t len, GString *reply) {
  int32_t ms;
  if (!spike_arg(payload, len, 0, &ms) || ms < 0)
    return;
  if (idle_state == PENDING) {
    spike_reply(reply, -EBUSY);
    return;
  }
  idle_state = PENDING;
  g_thread_unref(
      g_thread_new("idle-later", sleep_then_idle, GINT_TO_POINTER(ms)));
  spike_reply(reply, 0);
}

/* idle-result(): microseconds from the attach to the dispatch. */
static void idle_result(const uint8_t *payload, uint32_t len, GString *reply) {
  (void)payload;
  (void)len;
  switch (idle_state) {
  case IDLE:
    spike_reply(reply, -ENOENT);
    break;
  case PENDING:
    spike_reply(reply, -EAGAIN);
    break;
  case DONE:
    spike_reply(reply, (int32_t)MIN(idle_delay, G_MAXINT32));
    break;
  }
}

static gpointer count_run(gpointer data) {
  (void)data;
  g_atomic_int_inc(&spawn_ran);
  return NULL;
}

/* Runs from a pump, as an engine's own code would create threads. */
static gboolean spawn_all(gpointer n) {
  GThread *threads[MAX_SPAWN];
  int created = 0;

  for (; created < GPOINTER_TO_INT(n); created++) {
    GError *error = NULL;
    threads[created] = g_thread_try_new("spawn", count_run, NULL, &error);
    if (threads[created] == NULL) {
      g_warning("spawn: thread %d of %d: %s", created + 1, GPOINTER_TO_INT(n),
                error->message);
      g_error_free(error);
      break;
    }
  }
  for (int i = 0; i < created; i++)
    g_thread_join(threads[i]);
  spawn_joined = g_atomic_int_get(&spawn_ran);
  spawn_state = DONE;
  return G_SOURCE_REMOVE;
}

/* spawn(n): the next pump creates n threads, then joins them. */
static void spawn(const uint8_t *payload, uint32_t len, GString *reply) {
  int32_t n;
  if (!spike_arg(payload, len, 0, &n) || n < 0 || n > MAX_SPAWN)
    return;
  if (spawn_state == PENDING) {
    spike_reply(reply, -EBUSY);
    return;
  }
  spawn_state = PENDING;
  g_atomic_int_set(&spawn_ran, 0);
  g_idle_add(spawn_all, GINT_TO_POINTER(n));
  spike_reply(reply, 0);
}

/* spawn-result(): how many of the threads ran and were joined. */
static void spawn_result(const uint8_t *payload, uint32_t len, GString *reply) {
  (void)payload;
  (void)len;
  switch (spawn_state) {
  case IDLE:
    spike_reply(reply, -ENOENT);
    break;
  case PENDING:
    spike_reply(reply, -EAGAIN);
    break;
  case DONE:
    spike_reply(reply, spawn_joined);
    break;
  }
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, SPIKE_OP_IDLE_LATER, "idle-later", idle_later);
  ibusweb_module_add_op(module, SPIKE_OP_IDLE_RESULT, "idle-result",
                        idle_result);
  ibusweb_module_add_op(module, SPIKE_OP_SPAWN, "spawn", spawn);
  ibusweb_module_add_op(module, SPIKE_OP_SPAWN_RESULT, "spawn-result",
                        spawn_result);
}
