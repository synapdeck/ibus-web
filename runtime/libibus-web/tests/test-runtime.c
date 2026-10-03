/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <errno.h>
#include <glib-unix.h>
#include <glib.h>
#include <ibus-web/runtime.h>
#include <string.h>
#include <unistd.h>

/* The runtime and its opcode table are process-wide, so every case sets up
 * what it needs through these and tolerates an earlier case having done so. */
static int32_t wake_word;

static void runtime_ready(void) {
  int ret = ibusweb_runtime_init(&wake_word);
  g_assert_true(ret == 0 || ret == -EALREADY);
}

static gboolean count_dispatch(gpointer counter) {
  (*(int *)counter)++;
  return G_SOURCE_REMOVE;
}

static gboolean count_forever(gpointer counter) {
  (*(int *)counter)++;
  return G_SOURCE_CONTINUE;
}

static gboolean count_readable(gint fd, GIOCondition condition,
                               gpointer counter) {
  (void)fd;
  (void)condition;
  (*(int *)counter)++;
  return G_SOURCE_REMOVE;
}

static gpointer add_idle(gpointer counter) {
  g_idle_add(count_dispatch, counter);
  return NULL;
}

static gpointer pump_elsewhere(gpointer delay) {
  *(int32_t *)delay = ibusweb_pump();
  return NULL;
}

static GMutex holder_lock;
static GCond holder_cond;
static gboolean holder_ready, holding, released;

/* Owns the default context until told to let go, as a thread running its
 * own main loop would. */
static gpointer hold_default_context(gpointer data) {
  (void)data;
  gboolean acquired = g_main_context_acquire(NULL);
  g_mutex_lock(&holder_lock);
  holder_ready = TRUE;
  holding = acquired;
  g_cond_signal(&holder_cond);
  while (!released)
    g_cond_wait(&holder_cond, &holder_lock);
  g_mutex_unlock(&holder_lock);
  if (acquired)
    g_main_context_release(NULL);
  return NULL;
}

/* Throws a C++ exception. */
void test_throwing_op(const uint8_t *payload, uint32_t len, GString *reply);

static void echo(const uint8_t *payload, uint32_t len, GString *reply) {
  g_string_append_len(reply, (const char *)payload, len);
}

static void register_echo(IBusWebModule *module) {
  ibusweb_module_add_op(module, 1, "echo", echo);
}

/* Takes a free opcode, then one the echo module holds: registration must
 * fail as a whole and leave the free opcode unregistered. */
static void register_clash(IBusWebModule *module) {
  ibusweb_module_add_op(module, 2, "clash-free", echo);
  ibusweb_module_add_op(module, 1, "clash-taken", echo);
}

static void register_throwing(IBusWebModule *module) {
  ibusweb_module_add_op(module, 4, "throwing", test_throwing_op);
}

static IBusWebModule *echo_module(void) {
  static IBusWebModule *module;
  if (module == NULL)
    g_assert_cmpint(ibusweb_register_module("echo", register_echo, &module), ==,
                    0);
  return module;
}

static int32_t call(uint32_t opcode, const char *payload, uint8_t *reply,
                    uint32_t reply_cap) {
  uint8_t request[64];
  uint32_t opcode_le = GUINT32_TO_LE(opcode);
  size_t len = strlen(payload);
  g_assert_cmpuint(sizeof opcode_le + len, <=, sizeof request);
  memcpy(request, &opcode_le, sizeof opcode_le);
  memcpy(request + sizeof opcode_le, payload, len);
  return ibusweb_test_dispatch(request, sizeof opcode_le + len, reply,
                               reply_cap);
}

static void test_init(void) {
  g_assert_cmpint(ibusweb_wait(0, 0), ==, -EINVAL);

  GThread *holder = g_thread_new("holder", hold_default_context, NULL);
  g_mutex_lock(&holder_lock);
  while (!holder_ready)
    g_cond_wait(&holder_cond, &holder_lock);
  g_assert_true(holding);
  g_assert_cmpint(ibusweb_runtime_init(&wake_word), ==, -EBUSY);
  released = TRUE;
  g_cond_signal(&holder_cond);
  g_mutex_unlock(&holder_lock);
  g_thread_join(holder);

  g_assert_cmpint(ibusweb_runtime_init(NULL), ==, -EINVAL);
  g_assert_cmpint(ibusweb_runtime_init(&wake_word), ==, 0);
  g_assert_cmpint(ibusweb_runtime_init(&wake_word), ==, -EALREADY);
}

static void test_pump_empty(void) {
  runtime_ready();
  g_assert_cmpint(ibusweb_pump(), ==, -1);
}

/* A source that stays ready would keep the pump from returning; it must
 * hand control back to the host instead, with nothing to wait for. */
static void test_pump_always_ready(void) {
  int dispatched = 0;

  runtime_ready();
  guint id = g_idle_add(count_forever, &dispatched);
  g_assert_cmpint(ibusweb_pump(), ==, 0);
  g_assert_cmpint(dispatched, >, 0);
  g_source_remove(id);
  g_assert_cmpint(ibusweb_pump(), ==, -1);
}

static void test_pump_wrong_thread(void) {
  int32_t delay = 0;

  runtime_ready();
  g_test_expect_message("ibus-web", G_LOG_LEVEL_CRITICAL,
                        "*off the thread that owns*");
  g_thread_join(g_thread_new("pump", pump_elsewhere, &delay));
  g_test_assert_expected_messages();
  g_assert_cmpint(delay, ==, IBUSWEB_PUMP_ERROR);
}

/* The host sleeps on the wake word, so an attach from another thread must
 * bump it, and the next pump must find the source. */
static void test_pump_wake(void) {
  int idled = 0;

  runtime_ready();
  int32_t before = g_atomic_int_get(&wake_word);
  g_thread_join(g_thread_new("idle", add_idle, &idled));
  g_assert_cmpint(g_atomic_int_get(&wake_word), !=, before);
  g_assert_cmpint(ibusweb_pump(), ==, -1);
  g_assert_cmpint(idled, ==, 1);
}

static void test_pump_deadline(void) {
  int fired = 0;

  runtime_ready();
  g_timeout_add(250, count_dispatch, &fired);
  int32_t remaining = ibusweb_pump();
  g_assert_cmpint(remaining, >=, 200);
  g_assert_cmpint(remaining, <=, 250);
  g_assert_cmpint(fired, ==, 0);
  g_usleep((gulong)remaining * G_TIME_SPAN_MILLISECOND);
  g_assert_cmpint(ibusweb_pump(), ==, -1);
  g_assert_cmpint(fired, ==, 1);
}

/* An fd turning ready signals nobody, so the pump must ask to be called back
 * while a source polls one. */
static void test_pump_fd(void) {
  int pipe_fds[2];
  int readable = 0;

  runtime_ready();
  g_assert_no_errno(pipe(pipe_fds));
  g_unix_fd_add(pipe_fds[0], G_IO_IN, count_readable, &readable);
  int32_t probing = ibusweb_pump();
  g_assert_cmpint(probing, >, 0);
  g_assert_cmpint(probing, <=, 10);
  g_assert_cmpint(readable, ==, 0);
  g_assert_cmpint(write(pipe_fds[1], "x", 1), ==, 1);
  g_assert_cmpint(ibusweb_pump(), ==, -1);
  g_assert_cmpint(readable, ==, 1);
  close(pipe_fds[0]);
  close(pipe_fds[1]);
}

static gpointer wait_elsewhere(gpointer ret) {
  *(int *)ret = ibusweb_wait(g_atomic_int_get(&wake_word), 0);
  return NULL;
}

static gpointer idle_after_20ms(gpointer counter) {
  g_usleep(20 * G_TIME_SPAN_MILLISECOND);
  g_idle_add(count_dispatch, counter);
  return NULL;
}

static gboolean do_nothing(gpointer data) {
  (void)data;
  return G_SOURCE_REMOVE;
}

static void note_thread(void *ran_on_runtime_thread) {
  *(int *)ran_on_runtime_thread = emscripten_is_main_runtime_thread() ? 1 : -1;
}

/* Blocks in a call proxied to the runtime's thread, which only a sleep that
 * runs proxied calls lets finish, then wakes it through the context. */
static gpointer proxy_then_idle(gpointer ran_on_runtime_thread) {
  if (emscripten_proxy_sync(emscripten_proxy_get_system_queue(),
                            emscripten_main_runtime_thread_id(), note_thread,
                            ran_on_runtime_thread))
    g_idle_add(do_nothing, NULL);
  return NULL;
}

static void test_wait_timeout(void) {
  runtime_ready();
  gint64 start = g_get_monotonic_time();
  g_assert_cmpint(ibusweb_wait(g_atomic_int_get(&wake_word), 20), ==,
                  -ETIMEDOUT);
  g_assert_cmpint(g_get_monotonic_time() - start, >=,
                  20 * G_TIME_SPAN_MILLISECOND);
  g_assert_cmpint(ibusweb_wait(g_atomic_int_get(&wake_word), 0), ==,
                  -ETIMEDOUT);
}

/* A wake that came between reading the word and sleeping must not be
 * slept through. */
static void test_wait_stale(void) {
  runtime_ready();
  g_assert_cmpint(ibusweb_wait(g_atomic_int_get(&wake_word) - 1, -1), ==, 0);
}

static void test_wait_wake(void) {
  int idled = 0;

  runtime_ready();
  int32_t seen = g_atomic_int_get(&wake_word);
  GThread *thread = g_thread_new("idle", idle_after_20ms, &idled);
  g_assert_cmpint(ibusweb_wait(seen, 5000), ==, 0);
  g_thread_join(thread);
  g_assert_cmpint(ibusweb_pump(), ==, -1);
  g_assert_cmpint(idled, ==, 1);
}

static void test_wait_proxied(void) {
  int ran_on_runtime_thread = 0;

  runtime_ready();
  int32_t seen = g_atomic_int_get(&wake_word);
  GThread *thread =
      g_thread_new("proxy", proxy_then_idle, &ran_on_runtime_thread);
  g_assert_cmpint(ibusweb_wait(seen, 5000), ==, 0);
  g_thread_join(thread);
  g_assert_cmpint(ran_on_runtime_thread, ==, 1);
  g_assert_cmpint(ibusweb_pump(), ==, -1);
}

static void test_wait_wrong_thread(void) {
  int ret = 0;

  runtime_ready();
  g_test_expect_message("ibus-web", G_LOG_LEVEL_CRITICAL,
                        "*off the thread that owns*");
  g_thread_join(g_thread_new("wait", wait_elsewhere, &ret));
  g_test_assert_expected_messages();
  g_assert_cmpint(ret, ==, -EPERM);
}

/* Stands for a stale module from an earlier call, which failures clear. */
#define STALE_MODULE ((IBusWebModule *)&wake_word)

static void test_module_register(void) {
  IBusWebModule *clash = STALE_MODULE;

  g_assert_nonnull(echo_module());
  g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING,
                        "Module clash *clash-taken*opcode 1*module echo*");
  g_assert_cmpint(ibusweb_register_module("clash", register_clash, &clash), ==,
                  -EEXIST);
  g_test_assert_expected_messages();
  g_assert_null(clash);
}

static void test_dispatch_echo(void) {
  uint8_t reply[8];

  echo_module();
  int32_t echoed = call(1, "hello", reply, sizeof reply);
  g_assert_cmpint(echoed, ==, 5);
  g_assert_cmpmem(reply, echoed, "hello", 5);
}

static void test_dispatch_errors(void) {
  uint8_t reply[8];

  echo_module();
  g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING, "Module clash *");
  g_assert_cmpint(ibusweb_register_module("clash", register_clash, NULL), ==,
                  -EEXIST);
  g_test_assert_expected_messages();
  memset(reply, 'x', sizeof reply);
  g_assert_cmpint(call(1, "hello", reply, 4), ==, -ENOBUFS);
  g_assert_cmpint(reply[0], ==, 'x');
  /* The clashing module's free opcode was rolled back. */
  g_assert_cmpint(call(2, "", reply, sizeof reply), ==, -ENOSYS);
  g_assert_cmpint(call(99, "", reply, sizeof reply), ==, -ENOSYS);
  g_assert_cmpint(
      ibusweb_test_dispatch((const uint8_t *)"abc", 3, reply, sizeof reply), ==,
      -EINVAL);
}

/* The exception must stop in the runtime and fail only its own dispatch. */
static void test_dispatch_throw(void) {
  uint8_t reply[8];

  echo_module();
  g_assert_cmpint(ibusweb_register_module("throwing", register_throwing, NULL),
                  ==, 0);
  memset(reply, 'x', sizeof reply);
  g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING,
                        "Operation 4 threw: thrown by an operation");
  g_assert_cmpint(call(4, "", reply, sizeof reply), ==, -ECANCELED);
  g_test_assert_expected_messages();
  g_assert_cmpint(reply[0], ==, 'x');
  g_assert_cmpint(call(1, "hi", reply, sizeof reply), ==, 2);
}

static void test_module_load(void) {
  IBusWebModule *side = NULL;
  uint8_t reply[8];

  gchar *path = g_test_build_filename(G_TEST_BUILT, "test-side.wasm", NULL);
  g_assert_cmpint(ibusweb_load_module(path, &side), ==, 0);
  g_assert_nonnull(side);
  int32_t twice = call(3, "ab", reply, sizeof reply);
  g_assert_cmpint(twice, ==, 4);
  g_assert_cmpmem(reply, twice, "abab", 4);
  g_free(path);
}

static void test_module_load_missing(void) {
  IBusWebModule *missing = STALE_MODULE;

  g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING, "*side module*");
  g_assert_cmpint(ibusweb_load_module("/nonexistent/side.wasm", &missing), ==,
                  -ENOENT);
  g_test_assert_expected_messages();
  g_assert_null(missing);
}

static void test_module_load_not_module(void) {
  IBusWebModule *module = STALE_MODULE;

  const gchar *path = g_test_get_filename(G_TEST_DIST, "test-side.c", NULL);
  g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING, "*side module*");
  g_assert_cmpint(ibusweb_load_module(path, &module), ==, -ENOEXEC);
  g_test_assert_expected_messages();
  g_assert_null(module);
}

static void test_module_load_no_entry_point(void) {
  IBusWebModule *module = STALE_MODULE;

  gchar *path =
      g_test_build_filename(G_TEST_BUILT, "test-side-bare.wasm", NULL);
  g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING,
                        "*has no ibusweb_module_init*");
  g_assert_cmpint(ibusweb_load_module(path, &module), ==, -ENOEXEC);
  g_test_assert_expected_messages();
  g_assert_null(module);
  g_free(path);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);

  /* First, while nothing has set the runtime up or owns the default
   * context. */
  g_test_add_func("/runtime/init", test_init);
  g_test_add_func("/pump/empty", test_pump_empty);
  g_test_add_func("/pump/always-ready", test_pump_always_ready);
  g_test_add_func("/pump/wrong-thread", test_pump_wrong_thread);
  g_test_add_func("/pump/wake", test_pump_wake);
  g_test_add_func("/pump/deadline", test_pump_deadline);
  g_test_add_func("/pump/fd", test_pump_fd);
  g_test_add_func("/wait/timeout", test_wait_timeout);
  g_test_add_func("/wait/stale", test_wait_stale);
  g_test_add_func("/wait/wake", test_wait_wake);
  g_test_add_func("/wait/proxied", test_wait_proxied);
  g_test_add_func("/wait/wrong-thread", test_wait_wrong_thread);
  g_test_add_func("/module/register", test_module_register);
  g_test_add_func("/dispatch/echo", test_dispatch_echo);
  g_test_add_func("/dispatch/errors", test_dispatch_errors);
  g_test_add_func("/dispatch/throw", test_dispatch_throw);
  g_test_add_func("/module/load", test_module_load);
  g_test_add_func("/module/load-missing", test_module_load_missing);
  g_test_add_func("/module/load-not-module", test_module_load_not_module);
  g_test_add_func("/module/load-no-entry-point",
                  test_module_load_no_entry_point);

  return g_test_run();
}
