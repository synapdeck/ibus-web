/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* A g_test program, which reports in TAP, with a case that passes, one that
 * fails on purpose, one slow enough that g_test reports its time and one
 * that checks the arguments it was given. */

#include <glib.h>

static int program_argc;
static char **program_argv;

static void passes(void) { g_assert_cmpint(2 + 2, ==, 4); }

static void fails_on_purpose(void) { g_test_fail_printf("fails on purpose"); }

static void slow(void) { g_usleep(600 * G_TIME_SPAN_MILLISECOND); }

static void arguments(void) {
  g_assert_cmpint(program_argc, ==, 3);
  g_assert_cmpstr(program_argv[1], ==, "first argument");
  g_assert_cmpstr(program_argv[2], ==, "second");
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  /* What g_test_init() leaves: the program's own arguments. */
  program_argc = argc;
  program_argv = argv;
  g_test_add_func("/fixture/passes", passes);
  g_test_add_func("/fixture/fails-on-purpose", fails_on_purpose);
  g_test_add_func("/fixture/slow", slow);
  g_test_add_func("/fixture/arguments", arguments);
  return g_test_run();
}
