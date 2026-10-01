/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#include <errno.h>
#include <glib-unix.h>
#include <glib.h>
#include <ibus-web/runtime.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

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

static int32_t call(uint32_t opcode, const char *payload, uint8_t *reply,
                    uint32_t reply_cap) {
  uint8_t request[64];
  uint32_t opcode_le = GUINT32_TO_LE(opcode);
  size_t len = strlen(payload);
  memcpy(request, &opcode_le, sizeof opcode_le);
  memcpy(request + sizeof opcode_le, payload, len);
  return ibusweb_dispatch(request, sizeof opcode_le + len, reply, reply_cap);
}

int main(int argc, char **argv) {
  static int32_t word;
  int first = ibusweb_runtime_init(&word);
  printf("init %d %d\n", first, ibusweb_runtime_init(&word) == -EALREADY);
  printf("empty %d\n", ibusweb_pump());

  /* The host sleeps on the wake word, so an attach from another thread must
   * bump it, and the next pump must find the source. */
  int idled = 0;
  int32_t before = g_atomic_int_get(&word);
  g_thread_join(g_thread_new("idle", add_idle, &idled));
  int woken = g_atomic_int_get(&word) != before;
  int32_t after_idle = ibusweb_pump();
  printf("wake %d %d %d\n", woken, idled, after_idle);

  int fired = 0;
  g_timeout_add(250, count_dispatch, &fired);
  int32_t remaining = ibusweb_pump();
  g_usleep((gulong)remaining * G_TIME_SPAN_MILLISECOND);
  int32_t after_timeout = ibusweb_pump();
  printf("deadline %d %d %d\n", remaining >= 200 && remaining <= 250, fired,
         after_timeout);

  /* An fd turning ready signals nobody, so the pump must ask to be called
   * back while a source polls one. */
  int pipe_fds[2];
  int readable = 0;
  if (pipe(pipe_fds) != 0)
    return 1;
  g_unix_fd_add(pipe_fds[0], G_IO_IN, count_readable, &readable);
  int32_t probing = ibusweb_pump();
  int written = write(pipe_fds[1], "x", 1) == 1;
  int32_t after_read = ibusweb_pump();
  printf("fdpoll %d %d %d %d\n", probing > 0 && probing <= 10, written,
         readable, after_read);
  close(pipe_fds[0]);
  close(pipe_fds[1]);

  IBusWebModule *echo_module = NULL;
  IBusWebModule *clash_module = NULL;
  int echo_added = ibusweb_register_module("echo", register_echo, &echo_module);
  int clash_added =
      ibusweb_register_module("clash", register_clash, &clash_module);
  printf("register %d %d %d %d\n", echo_added, echo_module != NULL,
         clash_added == -EEXIST, clash_module == NULL);

  uint8_t reply[8];
  int32_t echoed = call(1, "hello", reply, sizeof reply);
  printf("echo %d %.*s\n", echoed, echoed > 0 ? echoed : 0, (char *)reply);

  memset(reply, 'x', sizeof reply);
  int too_long = call(1, "hello", reply, 4) == -ENOBUFS && reply[0] == 'x';
  int rolled_back = call(2, "", reply, sizeof reply) == -ENOSYS;
  int unknown = call(99, "", reply, sizeof reply) == -ENOSYS;
  int truncated = ibusweb_dispatch((const uint8_t *)"abc", 3, reply,
                                   sizeof reply) == -EINVAL;
  printf("errors %d %d %d %d\n", too_long, rolled_back, unknown, truncated);

  if (argc > 1) {
    IBusWebModule *side = NULL;
    int loaded = ibusweb_load_module(argv[1], &side);
    int32_t twice = call(3, "ab", reply, sizeof reply);
    printf("side %d %d %d %.*s\n", loaded, side != NULL, twice,
           twice > 0 ? twice : 0, (char *)reply);
    IBusWebModule *missing = NULL;
    printf("missing %d\n", ibusweb_load_module("/nonexistent/side.wasm",
                                               &missing) == -ENOEXEC &&
                               missing == NULL);
  }
  return 0;
}
