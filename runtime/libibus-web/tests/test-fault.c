/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

/* A fault is for the runtime's lifetime, so it runs in a program of its
 * own. */
#include <errno.h>
#include <ibus-web/protocol.h>
#include <ibus-web/runtime.h>
#include <string.h>

extern gboolean test_throwing_source(gpointer data);
extern gboolean test_invoke_throwing_closure(void);

static gboolean count(gpointer counter) {
  (*(int *)counter)++;
  return G_SOURCE_REMOVE;
}

static gpointer throw_elsewhere(gpointer closure_whole) {
  *(gboolean *)closure_whole = test_invoke_throwing_closure();
  return NULL;
}

/* A source's exception stops in the runtime's catch: the pump returns at
 * once and keeps the reason, and GLib finished the dispatch, keeping the
 * source. Nothing more reaches an engine on the pumping thread, neither the
 * rest of the thrower's batch nor sources GLib's own iteration dispatches. A
 * handler's exception on another thread, after the first, keeps the first
 * reason but still wakes the host. */
static void test_fault(void) {
  static int32_t wake_word;
  g_assert_cmpint(ibusweb_runtime_init(&wake_word), ==, 0);

  int ran = 0;
  int ran_alongside = 0;
  guint thrower = g_idle_add(test_throwing_source, NULL);
  guint alongside = g_idle_add(count, &ran_alongside);
  guint later = g_idle_add_full(G_PRIORITY_LOW, count, &ran, NULL);
  g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING,
                        "An engine threw: thrown by a source");
  g_assert_cmpint(ibusweb_pump(), ==, -1);
  g_test_assert_expected_messages();
  g_assert_cmpstr(ibusweb_fault_reason(), ==, "thrown by a source");
  g_assert_cmpint(g_main_depth(), ==, 0);
  g_assert_cmpint(ran_alongside, ==, 0);
  g_assert_cmpint(ran, ==, 0);
  g_assert_cmpint(ibusweb_pump(), ==, -1);
  g_assert_cmpint(ran, ==, 0);

  /* A Reset of context 1: the header, then the empty tuple's one byte. */
  IBusWebRequestHeader header = {GUINT16_TO_LE(IBUSWEB_REQ_RESET), 0,
                                 GUINT32_TO_LE(1)};
  guint8 reset[sizeof header + 1] = {0};
  memcpy(reset, &header, sizeof header);
  g_assert_cmpint(ibusweb_dispatch(reset, sizeof reset), ==, -ENOTRECOVERABLE);

  g_assert_true(g_main_context_iteration(NULL, FALSE));
  g_assert_cmpint(ran_alongside, ==, 0);
  g_assert_nonnull(g_main_context_find_source_by_id(NULL, thrower));
  g_assert_nonnull(g_main_context_find_source_by_id(NULL, alongside));
  g_source_remove(thrower);
  g_source_remove(alongside);
  g_assert_true(g_main_context_iteration(NULL, FALSE));
  g_assert_cmpint(ran, ==, 0);
  g_source_remove(later);

  gboolean closure_whole = FALSE;
  int32_t seen = g_atomic_int_get(&wake_word);
  g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING,
                        "An engine threw: thrown by a handler");
  GThread *thread = g_thread_new("thrower", throw_elsewhere, &closure_whole);
  g_assert_cmpint(ibusweb_wait(seen, 5000), ==, 0);
  g_thread_join(thread);
  g_test_assert_expected_messages();
  g_assert_true(closure_whole);
  g_assert_cmpstr(ibusweb_fault_reason(), ==, "thrown by a source");
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  g_test_add_func("/fault/caught", test_fault);
  return g_test_run();
}
