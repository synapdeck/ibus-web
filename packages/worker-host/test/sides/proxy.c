/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#include "test-ops.h"

#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <errno.h>
#include <gio/gio.h>

typedef enum { IDLE, PENDING, DONE } State;

/* Each operation's state is only touched on the pumping thread. */
static State proxy_state;
static gint64 proxy_started;
static int32_t proxy_result;

static State task_state;
static gint64 task_started;
static int32_t task_result;

static int32_t since(gint64 start) {
  return (int32_t)MIN(g_get_monotonic_time() - start, G_MAXINT32);
}

static gboolean record_proxy(gpointer ran_on_runtime_thread) {
  proxy_result =
      GPOINTER_TO_INT(ran_on_runtime_thread) ? since(proxy_started) : -EXDEV;
  proxy_state = DONE;
  return G_SOURCE_REMOVE;
}

static void note_thread(void *ran_on_runtime_thread) {
  *(gboolean *)ran_on_runtime_thread = emscripten_is_main_runtime_thread();
}

static gpointer proxy_then_report(gpointer data) {
  (void)data;
  gboolean ran_on_runtime_thread = FALSE;
  if (!emscripten_proxy_sync(emscripten_proxy_get_system_queue(),
                             emscripten_main_runtime_thread_id(), note_thread,
                             &ran_on_runtime_thread))
    g_warning("proxy-sync: the call was not proxied");
  g_idle_add(record_proxy, GINT_TO_POINTER(ran_on_runtime_thread));
  return NULL;
}

/* proxy-sync(): a thread proxies a call synchronously to the thread that
 * instantiated the runtime, then reports to the default context. */
static void proxy_sync(const uint8_t *payload, uint32_t len, GString *reply) {
  (void)payload;
  (void)len;
  if (proxy_state == PENDING) {
    test_reply(reply, -EBUSY);
    return;
  }
  proxy_state = PENDING;
  proxy_started = g_get_monotonic_time();
  g_thread_unref(g_thread_new("proxy-sync", proxy_then_report, NULL));
  test_reply(reply, 0);
}

/* proxy-sync-result(): microseconds from the request to the report, or
 * -EXDEV if the call ran on some other thread. */
static void proxy_sync_result(const uint8_t *payload, uint32_t len,
                              GString *reply) {
  (void)payload;
  (void)len;
  switch (proxy_state) {
  case IDLE:
    test_reply(reply, -ENOENT);
    break;
  case PENDING:
    test_reply(reply, -EAGAIN);
    break;
  case DONE:
    test_reply(reply, proxy_result);
    break;
  }
}

static void in_thread(GTask *task, gpointer source, gpointer data,
                      GCancellable *cancellable) {
  (void)source;
  (void)data;
  (void)cancellable;
  g_task_return_int(task, 1);
}

static void task_done(GObject *source, GAsyncResult *result, gpointer data) {
  (void)source;
  (void)data;
  GError *error = NULL;
  gssize value = g_task_propagate_int(G_TASK(result), &error);
  if (error != NULL) {
    g_warning("task: %s", error->message);
    g_error_free(error);
    task_result = -EIO;
  } else {
    task_result = value == 1 ? since(task_started) : -EIO;
  }
  task_state = DONE;
}

/* Pushing a task can wait for GLib's pool to create a worker, which takes
 * a creation proxied to the runtime's thread; pushed from that thread, the
 * push itself would be what waits, in a futex wait that runs the creation. */
static gpointer start_task(gpointer data) {
  (void)data;
  GTask *t = g_task_new(NULL, NULL, task_done, NULL);
  g_task_run_in_thread(t, in_thread);
  g_object_unref(t);
  return NULL;
}

/* task(): a thread runs a GTask in GLib's thread pool, whose workers yet
 * another thread creates, and the task returns its result to the default
 * context. */
static void task(const uint8_t *payload, uint32_t len, GString *reply) {
  (void)payload;
  (void)len;
  if (task_state == PENDING) {
    test_reply(reply, -EBUSY);
    return;
  }
  task_state = PENDING;
  task_started = g_get_monotonic_time();
  g_thread_unref(g_thread_new("task", start_task, NULL));
  test_reply(reply, 0);
}

/* task-result(): microseconds from the request to the callback. */
static void task_result_op(const uint8_t *payload, uint32_t len,
                           GString *reply) {
  (void)payload;
  (void)len;
  switch (task_state) {
  case IDLE:
    test_reply(reply, -ENOENT);
    break;
  case PENDING:
    test_reply(reply, -EAGAIN);
    break;
  case DONE:
    test_reply(reply, task_result);
    break;
  }
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, TEST_OP_PROXY_SYNC, "proxy-sync", proxy_sync);
  ibusweb_module_add_op(module, TEST_OP_PROXY_SYNC_RESULT, "proxy-sync-result",
                        proxy_sync_result);
  ibusweb_module_add_op(module, TEST_OP_TASK, "task", task);
  ibusweb_module_add_op(module, TEST_OP_TASK_RESULT, "task-result",
                        task_result_op);
}
