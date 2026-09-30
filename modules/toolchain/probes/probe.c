/*
 * SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 *
 * SPDX-License-Identifier: MIT OR Apache-2.0
 */

#include <pthread.h>
#include <stdio.h>

static void *echo(void *arg) { return arg; }

int main(void) {
  pthread_t thread;
  void *result = NULL;
  int value = 7;

  if (pthread_create(&thread, NULL, echo, &value) != 0)
    return 1;
  if (pthread_join(thread, &result) != 0)
    return 2;

  FILE *f = fopen("/tmp/probe.txt", "w");
  if (f != NULL) {
    fputs("ok", f);
    fclose(f);
  }

  printf("probe %d\n", *(int *)result);
  return 0;
}
