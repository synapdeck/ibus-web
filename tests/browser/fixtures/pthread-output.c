/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Prints from a pthread as the last thing before the program exits. The
 * runner's output must include the line. */

#include <pthread.h>
#include <stdio.h>

static void *print_last(void *unused) {
  (void)unused;
  printf("pthread-output: last line, from a pthread\n");
  return NULL;
}

int main(void) {
  pthread_t thread;
  if (pthread_create(&thread, NULL, print_last, NULL) != 0)
    return 1;
  pthread_join(thread, NULL);
  return 0;
}
