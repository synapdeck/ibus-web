/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

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
  return ibusweb_dispatch(request, sizeof opcode_le + len, reply, reply_cap);
}

static void test_init(void) {
  g_assert_cmpint(ibusweb_runtime_init(NULL), ==, -EINVAL);
  g_assert_cmpint(ibusweb_runtime_init(&wake_word), ==, 0);
  g_assert_cmpint(ibusweb_runtime_init(&wake_word), ==, -EALREADY);
}

static void test_pump_empty(void) {
  runtime_ready();
  g_assert_cmpint(ibusweb_pump(), ==, -1);
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

static void test_module_register(void) {
  IBusWebModule *clash = NULL;

  g_assert_nonnull(echo_module());
  g_test_expect_message(NULL, G_LOG_LEVEL_WARNING, "Opcode 1 *taken*");
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
  memset(reply, 'x', sizeof reply);
  g_assert_cmpint(call(1, "hello", reply, 4), ==, -ENOBUFS);
  g_assert_cmpint(reply[0], ==, 'x');
  /* The clashing module's free opcode was rolled back. */
  g_assert_cmpint(call(2, "", reply, sizeof reply), ==, -ENOSYS);
  g_assert_cmpint(call(99, "", reply, sizeof reply), ==, -ENOSYS);
  g_assert_cmpint(
      ibusweb_dispatch((const uint8_t *)"abc", 3, reply, sizeof reply), ==,
      -EINVAL);
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
  IBusWebModule *missing = NULL;

  g_test_expect_message(NULL, G_LOG_LEVEL_WARNING, "*side module*");
  g_assert_cmpint(ibusweb_load_module("/nonexistent/side.wasm", &missing), ==,
                  -ENOEXEC);
  g_test_assert_expected_messages();
  g_assert_null(missing);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);

  /* First, while nothing has set the runtime up yet. */
  g_test_add_func("/runtime/init", test_init);
  g_test_add_func("/pump/empty", test_pump_empty);
  g_test_add_func("/pump/wake", test_pump_wake);
  g_test_add_func("/pump/deadline", test_pump_deadline);
  g_test_add_func("/pump/fd", test_pump_fd);
  g_test_add_func("/module/register", test_module_register);
  g_test_add_func("/dispatch/echo", test_dispatch_echo);
  g_test_add_func("/dispatch/errors", test_dispatch_errors);
  g_test_add_func("/module/load", test_module_load);
  g_test_add_func("/module/load-missing", test_module_load_missing);

  return g_test_run();
}
