/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#include "spike.h"

#include <errno.h>

/* Never more threads than a host could mean to test the pool with. */
#define MAX_SPAWN 64

/* A thread from the pool starts at once. One beyond it needs a new Worker,
 * which may not start before the creating thread returns to its event loop
 * (Node starts it anyway, browsers need not), so joining it from a pump
 * could block for good. */
#define START_TIMEOUT (5 * G_TIME_SPAN_SECOND)

typedef enum { IDLE, PENDING, DONE } State;

/* Each operation's state is only touched on the pumping thread, except
 * where noted. */
static State idle_state;
static gint64 idle_attached; /* written by the sleeping thread */
static gint64 idle_delay;

static State spawn_state;
static int32_t spawn_joined;

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

static gpointer report_start(gpointer started) {
  g_async_queue_push(started, GINT_TO_POINTER(TRUE));
  g_async_queue_unref(started);
  return NULL;
}

/* Runs from a pump, as an engine's own code would create threads. Each
 * thread must start before the next is created, and only those that did are
 * joined; one that doesn't start in time is left to run whenever it can. */
static gboolean spawn_all(gpointer n) {
  GThread *threads[MAX_SPAWN];
  GAsyncQueue *started = g_async_queue_new();
  int running = 0;

  while (running < GPOINTER_TO_INT(n)) {
    GError *error = NULL;
    GThread *thread = g_thread_try_new("spawn", report_start,
                                       g_async_queue_ref(started), &error);
    if (thread == NULL) {
      g_warning("spawn: thread %d of %d: %s", running + 1, GPOINTER_TO_INT(n),
                error->message);
      g_error_free(error);
      g_async_queue_unref(started);
      break;
    }
    if (g_async_queue_timeout_pop(started, START_TIMEOUT) == NULL) {
      g_warning("spawn: thread %d of %d didn't start", running + 1,
                GPOINTER_TO_INT(n));
      g_thread_unref(thread);
      break;
    }
    threads[running++] = thread;
  }
  for (int i = 0; i < running; i++)
    g_thread_join(threads[i]);
  g_async_queue_unref(started);
  spawn_joined = running;
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
  g_idle_add(spawn_all, GINT_TO_POINTER(n));
  spike_reply(reply, 0);
}

/* spawn-result(): how many of the threads started and were joined. */
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
