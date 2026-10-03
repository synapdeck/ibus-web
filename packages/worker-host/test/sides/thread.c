/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#include "test-ops.h"

#include <errno.h>

/* Never more threads than a host could mean to test the pool with. */
#define MAX_SPAWN 64

/* A thread from the pool starts within milliseconds. This bounds a pump's
 * wait for one that doesn't, such as one handed a Worker that hasn't
 * started, which a pump that never returns to its event loop could
 * otherwise wait for forever. */
#define START_TIMEOUT (5 * G_TIME_SPAN_SECOND)

typedef enum { IDLE, PENDING, DONE } State;

/* Each operation's state is only touched on the pumping thread, except
 * where noted. */
static State idle_state;
static gint64 idle_attached; /* written by the sleeping thread */
static gint64 idle_delay;

static State spawn_state;
static int32_t spawn_joined;
static int32_t spawn_error;

static State detached_state;
static int32_t detached_expected;
static int32_t detached_reported;

static State nested_state;
static int32_t nested_joined;
static int32_t nested_error;

/* Threads hold() started, waiting for release(). */
static GMutex held_lock;
static GCond held_cond;
static gboolean held_released;
static GPtrArray *held;

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
  if (!test_arg(payload, len, 0, &ms) || ms < 0)
    return;
  if (idle_state == PENDING) {
    test_reply(reply, -EBUSY);
    return;
  }
  idle_state = PENDING;
  g_thread_unref(
      g_thread_new("idle-later", sleep_then_idle, GINT_TO_POINTER(ms)));
  test_reply(reply, 0);
}

/* idle-result(): microseconds from the attach to the dispatch. */
static void idle_result(const uint8_t *payload, uint32_t len, GString *reply) {
  (void)payload;
  (void)len;
  switch (idle_state) {
  case IDLE:
    test_reply(reply, -ENOENT);
    break;
  case PENDING:
    test_reply(reply, -EAGAIN);
    break;
  case DONE:
    test_reply(reply, (int32_t)MIN(idle_delay, G_MAXINT32));
    break;
  }
}

static gpointer report_start(gpointer started) {
  g_async_queue_push(started, GINT_TO_POINTER(TRUE));
  g_async_queue_unref(started);
  return NULL;
}

/* What a creation that failed in g_thread_try_new() reports: -EAGAIN for
 * GLib's G_THREAD_ERROR_AGAIN, which is pthread_create()'s EAGAIN. */
static int32_t creation_error(GError *error) {
  return g_error_matches(error, G_THREAD_ERROR, G_THREAD_ERROR_AGAIN) ? -EAGAIN
                                                                      : -EIO;
}

/* Creates n threads with func, each of which must report its start on the
 * queue before the next is created. Returns how many started; *error is 0,
 * the failed creation's error, or -ETIMEDOUT for a thread that didn't start
 * in time, which is left to run whenever it can. */
static int create_started(int n, GThreadFunc func, GThread **threads,
                          GAsyncQueue *started, int32_t *error) {
  int running = 0;
  *error = 0;
  while (running < n) {
    GError *local = NULL;
    GThread *thread =
        g_thread_try_new("spawn", func, g_async_queue_ref(started), &local);
    if (thread == NULL) {
      g_warning("spawn: thread %d of %d: %s", running + 1, n, local->message);
      *error = creation_error(local);
      g_error_free(local);
      g_async_queue_unref(started);
      break;
    }
    if (g_async_queue_timeout_pop(started, START_TIMEOUT) == NULL) {
      g_warning("spawn: thread %d of %d didn't start", running + 1, n);
      *error = -ETIMEDOUT;
      g_thread_unref(thread);
      break;
    }
    threads[running++] = thread;
  }
  return running;
}

/* Creates n threads as create_started() does, then joins those that
 * started and returns how many. */
static int create_and_join(int n, int32_t *error) {
  GThread *threads[MAX_SPAWN];
  GAsyncQueue *started = g_async_queue_new();
  int running = create_started(n, report_start, threads, started, error);
  for (int i = 0; i < running; i++)
    g_thread_join(threads[i]);
  g_async_queue_unref(started);
  return running;
}

/* Runs from a pump, as an engine's own code would create threads. */
static gboolean spawn_all(gpointer n) {
  spawn_joined = create_and_join(GPOINTER_TO_INT(n), &spawn_error);
  spawn_state = DONE;
  return G_SOURCE_REMOVE;
}

/* spawn(n): the next pump creates n threads, then joins them. */
static void spawn(const uint8_t *payload, uint32_t len, GString *reply) {
  int32_t n;
  if (!test_arg(payload, len, 0, &n) || n < 0 || n > MAX_SPAWN)
    return;
  if (spawn_state == PENDING) {
    test_reply(reply, -EBUSY);
    return;
  }
  spawn_state = PENDING;
  g_idle_add(spawn_all, GINT_TO_POINTER(n));
  test_reply(reply, 0);
}

/* spawn-result(): how many of the threads started and were joined, then
 * create_started()'s error. */
static void spawn_result(const uint8_t *payload, uint32_t len, GString *reply) {
  (void)payload;
  (void)len;
  switch (spawn_state) {
  case IDLE:
    test_reply(reply, -ENOENT);
    break;
  case PENDING:
    test_reply(reply, -EAGAIN);
    break;
  case DONE:
    test_reply(reply, spawn_joined);
    test_reply(reply, spawn_error);
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
  if (!test_arg(payload, len, 0, &n) || n < 0 || n > MAX_SPAWN)
    return;
  if (detached_state == PENDING) {
    test_reply(reply, -EBUSY);
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
  test_reply(reply, detached_expected);
}

/* spawn-detached-result(): how many of the threads reported. */
static void spawn_detached_result(const uint8_t *payload, uint32_t len,
                                  GString *reply) {
  (void)payload;
  (void)len;
  switch (detached_state) {
  case IDLE:
    test_reply(reply, -ENOENT);
    break;
  case PENDING:
    test_reply(reply, -EAGAIN);
    break;
  case DONE:
    test_reply(reply, detached_reported);
    break;
  }
}

/* Written by the creating thread before it attaches record_nested(). */
static int32_t nested_joined_off_thread;
static int32_t nested_error_off_thread;

static gboolean record_nested(gpointer data) {
  (void)data;
  nested_joined = nested_joined_off_thread;
  nested_error = nested_error_off_thread;
  nested_state = DONE;
  return G_SOURCE_REMOVE;
}

static gpointer create_from_thread(gpointer n) {
  nested_joined_off_thread =
      create_and_join(GPOINTER_TO_INT(n), &nested_error_off_thread);
  g_idle_add(record_nested, NULL);
  return NULL;
}

/* spawn-nested(n): a thread off the pumping thread creates n threads and
 * joins them, as GLib's thread pools create their workers. Emscripten has
 * the thread that instantiated the runtime create every thread, so each
 * creation waits for that thread to run it. */
static void spawn_nested(const uint8_t *payload, uint32_t len, GString *reply) {
  int32_t n;
  if (!test_arg(payload, len, 0, &n) || n < 0 || n > MAX_SPAWN)
    return;
  if (nested_state == PENDING) {
    test_reply(reply, -EBUSY);
    return;
  }
  /* g_thread_new() would abort the runtime on a full pool. */
  GError *error = NULL;
  GThread *thread = g_thread_try_new("nested", create_from_thread,
                                     GINT_TO_POINTER(n), &error);
  if (thread == NULL) {
    test_reply(reply, creation_error(error));
    g_error_free(error);
    return;
  }
  nested_state = PENDING;
  g_thread_unref(thread);
  test_reply(reply, 0);
}

/* spawn-nested-result(): how many of the threads started and were joined,
 * then create_started()'s error. */
static void spawn_nested_result(const uint8_t *payload, uint32_t len,
                                GString *reply) {
  (void)payload;
  (void)len;
  switch (nested_state) {
  case IDLE:
    test_reply(reply, -ENOENT);
    break;
  case PENDING:
    test_reply(reply, -EAGAIN);
    break;
  case DONE:
    test_reply(reply, nested_joined);
    test_reply(reply, nested_error);
    break;
  }
}

static gpointer wait_for_release(gpointer started) {
  g_async_queue_push(started, GINT_TO_POINTER(TRUE));
  g_async_queue_unref(started);
  g_mutex_lock(&held_lock);
  while (!held_released)
    g_cond_wait(&held_cond, &held_lock);
  g_mutex_unlock(&held_lock);
  return NULL;
}

/* hold(n), on the pumping thread: creates n threads, as spawn does, that
 * keep their Workers until release(). Replies how many started, then the
 * error that stopped the rest. */
static void hold(const uint8_t *payload, uint32_t len, GString *reply) {
  int32_t n;
  if (!test_arg(payload, len, 0, &n) || n < 0 || n > MAX_SPAWN)
    return;
  if (held != NULL) {
    test_reply(reply, -EBUSY);
    return;
  }
  GThread *threads[MAX_SPAWN];
  GAsyncQueue *started = g_async_queue_new();
  int32_t error;
  held_released = FALSE;
  int running = create_started(n, wait_for_release, threads, started, &error);
  g_async_queue_unref(started);
  held = g_ptr_array_new();
  for (int i = 0; i < running; i++)
    g_ptr_array_add(held, threads[i]);
  test_reply(reply, running);
  test_reply(reply, error);
}

/* release(): lets hold()'s threads end and joins them; replies how many. */
static void release(const uint8_t *payload, uint32_t len, GString *reply) {
  (void)payload;
  (void)len;
  if (held == NULL) {
    test_reply(reply, -ENOENT);
    return;
  }
  g_mutex_lock(&held_lock);
  held_released = TRUE;
  g_cond_broadcast(&held_cond);
  g_mutex_unlock(&held_lock);
  int32_t joined = (int32_t)held->len;
  for (guint i = 0; i < held->len; i++)
    g_thread_join(g_ptr_array_index(held, i));
  g_clear_pointer(&held, g_ptr_array_unref);
  test_reply(reply, joined);
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
  test_reply(reply, 0);
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, TEST_OP_IDLE_LATER, "idle-later", idle_later);
  ibusweb_module_add_op(module, TEST_OP_IDLE_RESULT, "idle-result",
                        idle_result);
  ibusweb_module_add_op(module, TEST_OP_SPAWN, "spawn", spawn);
  ibusweb_module_add_op(module, TEST_OP_SPAWN_RESULT, "spawn-result",
                        spawn_result);
  ibusweb_module_add_op(module, TEST_OP_SPAWN_DETACHED, "spawn-detached",
                        spawn_detached);
  ibusweb_module_add_op(module, TEST_OP_SPAWN_DETACHED_RESULT,
                        "spawn-detached-result", spawn_detached_result);
  ibusweb_module_add_op(module, TEST_OP_SPAWN_NESTED, "spawn-nested",
                        spawn_nested);
  ibusweb_module_add_op(module, TEST_OP_SPAWN_NESTED_RESULT,
                        "spawn-nested-result", spawn_nested_result);
  ibusweb_module_add_op(module, TEST_OP_CRASH_THREAD, "crash-thread",
                        crash_thread);
  ibusweb_module_add_op(module, TEST_OP_HOLD, "hold", hold);
  ibusweb_module_add_op(module, TEST_OP_RELEASE, "release", release);
}
