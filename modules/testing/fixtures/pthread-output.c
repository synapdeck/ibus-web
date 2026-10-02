/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Prints its only test point and its plan from a pthread, the last output
 * before it exits: without them its TAP stream is not ok. It takes g_test's
 * -l, to list its one case, and ignores the rest of g_test's options, which
 * can only select that case. */

#include <pthread.h>
#include <stdio.h>
#include <string.h>

static void *finish(void *unused) {
  (void)unused;
  printf("ok 1 /pthread/output\n");
  printf("1..1\n");
  return NULL;
}

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "-l") == 0) {
      printf("/pthread/output\n");
      return 0;
    }
  }
  printf("TAP version 14\n");
  pthread_t thread;
  if (pthread_create(&thread, NULL, finish, NULL) != 0)
    return 1;
  pthread_join(thread, NULL);
  return 0;
}
