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

static State detached_state;
static int32_t detached_expected;
static int32_t detached_reported;

static State nested_state;
static int32_t nested_joined;

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

/* Creates n threads, each of which must start before the next is created,
 * then joins those that did and returns how many; one that doesn't start in
 * time is left to run whenever it can. */
static int create_and_join(int n) {
  GThread *threads[MAX_SPAWN];
  GAsyncQueue *started = g_async_queue_new();
  int running = 0;

  while (running < n) {
    GError *error = NULL;
    GThread *thread = g_thread_try_new("spawn", report_start,
                                       g_async_queue_ref(started), &error);
    if (thread == NULL) {
      g_warning("spawn: thread %d of %d: %s", running + 1, n, error->message);
      g_error_free(error);
      g_async_queue_unref(started);
      break;
    }
    if (g_async_queue_timeout_pop(started, START_TIMEOUT) == NULL) {
      g_warning("spawn: thread %d of %d didn't start", running + 1, n);
      g_thread_unref(thread);
      break;
    }
    threads[running++] = thread;
  }
  for (int i = 0; i < running; i++)
    g_thread_join(threads[i]);
  g_async_queue_unref(started);
  return running;
}

/* Runs from a pump, as an engine's own code would create threads. */
static gboolean spawn_all(gpointer n) {
  spawn_joined = create_and_join(GPOINTER_TO_INT(n));
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

static gboolean count_detached(gpointer data) {
  (void)data;
  if (++detached_reported == detached_expected)
    detached_state = DONE;
  return G_SOURCE_REMOVE;
}

static gpointer report_and_exit(gpointer data) {
  (void)data;
  g_idle_add(count_detached, NULL);
  return NULL;
}

/* spawn-detached(n): creates n detached threads, each of which reports to
 * the default context and ends; nobody joins them. */
static void spawn_detached(const uint8_t *payload, uint32_t len,
                           GString *reply) {
  int32_t n;
  if (!spike_arg(payload, len, 0, &n) || n < 0 || n > MAX_SPAWN)
    return;
  if (detached_state == PENDING) {
    spike_reply(reply, -EBUSY);
    return;
  }
  detached_expected = 0;
  detached_reported = 0;
  detached_state = PENDING;
  for (int i = 0; i < n; i++) {
    GError *error = NULL;
    GThread *thread =
        g_thread_try_new("detached", report_and_exit, NULL, &error);
    if (thread == NULL) {
      g_warning("spawn-detached: thread %d of %d: %s", i + 1, n,
                error->message);
      g_error_free(error);
      break;
    }
    g_thread_unref(thread);
    detached_expected++;
  }
  if (detached_expected == 0)
    detached_state = DONE;
  spike_reply(reply, detached_expected);
}

/* spawn-detached-result(): how many of the threads reported. */
static void spawn_detached_result(const uint8_t *payload, uint32_t len,
                                  GString *reply) {
  (void)payload;
  (void)len;
  switch (detached_state) {
  case IDLE:
    spike_reply(reply, -ENOENT);
    break;
  case PENDING:
    spike_reply(reply, -EAGAIN);
    break;
  case DONE:
    spike_reply(reply, detached_reported);
    break;
  }
}

static gboolean record_nested(gpointer joined) {
  nested_joined = GPOINTER_TO_INT(joined);
  nested_state = DONE;
  return G_SOURCE_REMOVE;
}

static gpointer create_from_thread(gpointer n) {
  g_idle_add(record_nested,
             GINT_TO_POINTER(create_and_join(GPOINTER_TO_INT(n))));
  return NULL;
}

/* spawn-nested(n): a thread off the pumping thread creates n threads and
 * joins them, as GLib's thread pools create their workers. Emscripten has
 * the thread that instantiated the runtime create every thread, so each
 * creation waits for that thread to run it. */
static void spawn_nested(const uint8_t *payload, uint32_t len, GString *reply) {
  int32_t n;
  if (!spike_arg(payload, len, 0, &n) || n < 0 || n > MAX_SPAWN)
    return;
  if (nested_state == PENDING) {
    spike_reply(reply, -EBUSY);
    return;
  }
  nested_state = PENDING;
  g_thread_unref(
      g_thread_new("nested", create_from_thread, GINT_TO_POINTER(n)));
  spike_reply(reply, 0);
}

/* spawn-nested-result(): how many of the threads started and were joined. */
static void spawn_nested_result(const uint8_t *payload, uint32_t len,
                                GString *reply) {
  (void)payload;
  (void)len;
  switch (nested_state) {
  case IDLE:
    spike_reply(reply, -ENOENT);
    break;
  case PENDING:
    spike_reply(reply, -EAGAIN);
    break;
  case DONE:
    spike_reply(reply, nested_joined);
    break;
  }
}

static gpointer trap(gpointer data) {
  (void)data;
  __builtin_trap();
}

/* crash-thread(): a thread traps, which takes the whole runtime down. */
static void crash_thread(const uint8_t *payload, uint32_t len, GString *reply) {
  (void)payload;
  (void)len;
  g_thread_unref(g_thread_new("crash", trap, NULL));
  spike_reply(reply, 0);
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, SPIKE_OP_IDLE_LATER, "idle-later", idle_later);
  ibusweb_module_add_op(module, SPIKE_OP_IDLE_RESULT, "idle-result",
                        idle_result);
  ibusweb_module_add_op(module, SPIKE_OP_SPAWN, "spawn", spawn);
  ibusweb_module_add_op(module, SPIKE_OP_SPAWN_RESULT, "spawn-result",
                        spawn_result);
  ibusweb_module_add_op(module, SPIKE_OP_SPAWN_DETACHED, "spawn-detached",
                        spawn_detached);
  ibusweb_module_add_op(module, SPIKE_OP_SPAWN_DETACHED_RESULT,
                        "spawn-detached-result", spawn_detached_result);
  ibusweb_module_add_op(module, SPIKE_OP_SPAWN_NESTED, "spawn-nested",
                        spawn_nested);
  ibusweb_module_add_op(module, SPIKE_OP_SPAWN_NESTED_RESULT,
                        "spawn-nested-result", spawn_nested_result);
  ibusweb_module_add_op(module, SPIKE_OP_CRASH_THREAD, "crash-thread",
                        crash_thread);
}
